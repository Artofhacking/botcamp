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

type ControlledWindow = {
  url?: string;
  navigate?: (url: string) => Promise<unknown>;
};

export type ServiceWorkerScope = {
  location: { origin: string };
  caches: CacheStorage;
  clients: {
    matchAll(options: { type: "window" }): Promise<readonly ControlledWindow[]>;
    claim?: () => Promise<void>;
  };
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
 * Precaches the app shell and serves hashed assets cache-first. A navigation
 * always asks the network for the entry document, and uses the cached shell
 * only while offline or when that document is missing. A new version takes
 * over as soon as it installs, then reloads open windows so they leave the
 * shell they were drawn from. The previous shell stays cached for a tab whose
 * reload has not finished.
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
        )
        .then(() => scope.skipWaiting()),
    );
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const names = await scope.caches.keys();
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
        await Promise.all(
          previous.filter((name) => name !== keep).map((name) => scope.caches.delete(name)),
        );
        await scope.clients.claim?.();
        // A first install has nothing to replace. An update does: open windows are still
        // drawing the previous shell until something reloads them.
        if (previous.length === 0) return;
        const windows = await scope.clients.matchAll({ type: "window" });
        await Promise.all(
          windows.map((client) =>
            client && typeof client.navigate === "function" && client.url
              ? client.navigate(client.url)
              : undefined,
          ),
        );
      })(),
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
    // A static host has no SPA fallback, so /console/app/<id> is not a document.
    // Ask for the entry itself, bypassing the HTTP cache: a cached shell here is
    // how an open tab keeps running the previous deployment. The cached shell is
    // only the offline and 404 fallback. The app then moves a deep path into the hash.
    const entryPath = appBase.replace(/\/$/, "") || "/";
    const inApp =
      appBase !== "/" &&
      (url.pathname === appBase || url.pathname === entryPath || url.pathname.startsWith(appBase));
    const target = inApp
      ? new Request(new URL(appBase, scope.location.origin), { cache: "reload" })
      : request;
    try {
      const response = await scope.fetch(target);
      if (inApp && !response.ok) throw new Error("shell missing");
      return response;
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
