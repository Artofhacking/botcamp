export const SKIP_WAITING = "rakazo:skip-waiting";
export const CACHE_PREFIX = "rakazo-shell-";

// Live data, auth callbacks and the screen proxy always go straight to the server.
const BYPASS_PREFIXES = ["/api", "/rpc", "/novnc", "/.well-known", "/health"];
const ACTIVATION_TIMEOUT_MS = 3_000;
const BUILD_ID = /^\d{14}$/;

type ExtendableEvent = { waitUntil(promise: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith(response: Promise<Response>): void;
};
type MessageEvent = ExtendableEvent & { data: unknown };

export type ServiceWorkerScope = {
  location: { origin: string };
  caches: CacheStorage;
  clients: { matchAll(options: { type: "window" }): Promise<readonly unknown[]> };
  registration: {
    waiting: Pick<ServiceWorker, "postMessage" | "addEventListener" | "removeEventListener"> | null;
  };
  skipWaiting(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export function bypassesServiceWorker(pathname: string): boolean {
  return BYPASS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Precaches the app shell, serves hashed assets cache-first and falls back to
 * the cached shell for navigations while offline. A new version waits until
 * the next navigation of the last open window, then takes over by reloading
 * that navigation. The previous shell stays cached for tabs still using it.
 */
export function installServiceWorker(
  scope: ServiceWorkerScope,
  precache: readonly string[],
  cacheName: string,
  base = "/",
): void {
  const precached = new Set(precache);
  const appBase = base.endsWith("/") ? base : `${base}/`;

  scope.addEventListener("install", (event) => {
    event.waitUntil(
      scope.caches
        .open(cacheName)
        .then((cache) =>
          cache.addAll(
            precache.map(
              (url) => new Request(new URL(url, scope.location.origin), { cache: "no-cache" }),
            ),
          ),
        ),
    );
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      scope.caches.keys().then((names) => {
        // Keep the newest previous shell for tabs still running its bundle. Names end in the build
        // id, which sorts oldest first; older workers named caches by a content hash instead, so
        // one of those is kept only when no build-named cache exists.
        const previous = names.filter(
          (name) => name.startsWith(CACHE_PREFIX) && name !== cacheName,
        );
        const byBuild = previous
          .filter((name) => BUILD_ID.test(name.slice(CACHE_PREFIX.length)))
          .sort();
        const keep = byBuild.at(-1) ?? previous.at(-1);
        return Promise.all(
          previous.filter((name) => name !== keep).map((name) => scope.caches.delete(name)),
        );
      }),
    );
  });

  scope.addEventListener("message", (event) => {
    if (event.data === SKIP_WAITING) event.waitUntil(scope.skipWaiting());
  });

  scope.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== scope.location.origin || bypassesServiceWorker(url.pathname)) return;
    if (request.mode === "navigate") {
      event.respondWith(navigate(request));
    } else if (precached.has(url.pathname) || url.pathname.startsWith("/assets/")) {
      event.respondWith(cacheFirst(event, url.pathname));
    }
  });

  async function navigate(request: Request): Promise<Response> {
    if (await activateWaitingWorker()) {
      return new Response("", { headers: { Refresh: "0" } });
    }
    const url = new URL(request.url);
    // A static host has no SPA fallback: /console/app/<id> answers 404 (or the site's other
    // page). Everything under the deployment's base is the app, so serve the cached shell
    // and let the router read the path. A new deploy still lands: the browser re-fetches the
    // worker on navigation and activateWaitingWorker() reloads into it.
    // 深层路径服务器只会给 404，直接回外壳；入口 `/console/` 必须联网，否则新版本永远装不上。
    const entry = url.pathname === appBase || url.pathname === appBase.replace(/\/$/, "");
    if (appBase !== "/" && url.pathname.startsWith(appBase) && !entry) {
      const shell = await shellFromCache();
      if (shell) return shell;
    }
    try {
      return await scope.fetch(request);
    } catch (error) {
      const shell = await shellFromCache();
      if (shell) return shell;
      throw error;
    }
  }

  async function shellFromCache(): Promise<Response | undefined> {
    const cache = await scope.caches.open(cacheName);
    return (await cache.match(appBase)) ?? (await cache.match(`${appBase}index.html`));
  }

  async function activateWaitingWorker(): Promise<boolean> {
    const waiting = scope.registration.waiting;
    if (!waiting) return false;
    if ((await scope.clients.matchAll({ type: "window" })).length > 1) return false;
    return new Promise((resolve) => {
      const changed = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiting.removeEventListener("statechange", changed);
        resolve(false);
      }, ACTIVATION_TIMEOUT_MS);
      waiting.addEventListener("statechange", changed, { once: true });
      waiting.postMessage(SKIP_WAITING);
    });
  }

  async function cacheFirst(event: FetchEvent, pathname: string): Promise<Response> {
    const cache = await scope.caches.open(cacheName);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    for (const name of await scope.caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === cacheName) continue;
      const previous = await (await scope.caches.open(name)).match(event.request);
      if (previous) return previous;
    }
    const response = await scope.fetch(event.request);
    // A missing chunk can come back as the SPA's HTML; never store that as an asset.
    const html = response.headers.get("content-type")?.includes("text/html") ?? false;
    if (response.ok && !html && pathname.startsWith("/assets/")) {
      event.waitUntil(cache.put(event.request, response.clone()).catch(() => undefined));
    }
    return response;
  }
}
