/**
 * A subpath deploy is a static host: only the entry document exists, and a
 * cache-bypassing reload (Shift+reload) never reaches the service worker.
 * The route lives in the hash, so that reload still requests the entry and
 * the path after `#` is what the router reads. A root deploy has a real
 * fallback and keeps ordinary paths.
 */

type Address = {
  hash?: string;
  href: string;
  origin: string;
  pathname: string;
  search: string;
};

export function hashRoutesEnabled(base = import.meta.env.BASE_URL): boolean {
  const normalized = base.trim();
  return normalized !== "" && normalized !== "/";
}

export function appBasePath(base = import.meta.env.BASE_URL): string {
  if (!base || base === "/") return "/";
  return base.endsWith("/") ? base : `${base}/`;
}

function basePrefix(base: string): string {
  const path = appBasePath(base);
  return path === "/" ? "" : path.slice(0, -1);
}

function pathFromHash(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const path = hash.slice(1).split("?")[0] || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/** The route the address bar is on, with the deploy base removed. */
export function documentPath(
  loc: { hash?: string; pathname: string } = window.location,
  base = import.meta.env.BASE_URL,
): string {
  if (hashRoutesEnabled(base)) {
    const fromHash = pathFromHash(loc.hash ?? "");
    if (fromHash) return fromHash;
  }
  const prefix = basePrefix(base);
  let path = loc.pathname || "/";
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
    path = path.slice(prefix.length) || "/";
  }
  if (!path.startsWith("/")) path = `/${path}`;
  if (hashRoutesEnabled(base) && path === "/index.html") return "/";
  return path;
}

/** The route's query string, which a hash route keeps after `#`. */
export function routeSearch(
  loc: { hash?: string; search: string } = window.location,
  base = import.meta.env.BASE_URL,
): string {
  if (hashRoutesEnabled(base)) {
    const hash = loc.hash ?? "";
    if (hash.startsWith("#")) {
      const body = hash.slice(1);
      const query = body.indexOf("?");
      if (query !== -1) return body.slice(query);
    }
  }
  return loc.search;
}

export function routePathOfUrl(url: URL, base = import.meta.env.BASE_URL): string {
  return documentPath(url, base);
}

/**
 * Move a path route (`/console/app/id?m=1`) into the hash without a request.
 * Null when the address is already an entry, a file, or a hash route.
 */
export function hashRouteReplacement(
  loc: { hash?: string; pathname: string; search: string },
  base = import.meta.env.BASE_URL,
): string | null {
  if (!hashRoutesEnabled(base)) return null;
  if ((loc.hash ?? "").startsWith("#/")) return null;
  const prefix = basePrefix(base);
  const { pathname, search } = loc;
  if (pathname === prefix || pathname === `${prefix}/` || pathname === `${prefix}/index.html`) {
    return null;
  }
  if (!pathname.startsWith(`${prefix}/`)) return null;
  // A dotted bot id is still a route. Only real static files stay as paths.
  const leaf = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (/\.(?:css|gif|html|ico|js|json|map|png|svg|txt|webmanifest|woff2?)$/i.test(leaf)) {
    return null;
  }
  return `${appBasePath(base)}#${pathname.slice(prefix.length)}${search}`;
}

export function adoptHashRoute(
  base = import.meta.env.BASE_URL,
  loc: { hash?: string; pathname: string; search: string } = window.location,
  replaceState: (url: string) => void = (url) => {
    window.history.replaceState(window.history.state, "", url);
  },
): void {
  const next = hashRouteReplacement(loc, base);
  if (!next) return;
  try {
    replaceState(next);
  } catch {
    // A frame that cannot rewrite its URL keeps the path. The next reload still loads the shell
    // only when the address was already a hash route.
  }
}

/**
 * The address that opens a shared page on this deploy. A subpath host has no
 * file at `/p/…`, so the link is the console entry with the route in the hash.
 */
export function directShareUrl(shareUrl: string, base = import.meta.env.BASE_URL): string {
  if (!hashRoutesEnabled(base)) return shareUrl;
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  if (!url.pathname.startsWith("/p/")) return shareUrl;
  return `${url.origin}${toAppDocument(`${url.pathname}${url.search}`, base)}`;
}

/** A full navigation that stays on the entry document when routes live in the hash. */
export function toAppDocument(url: string, base = import.meta.env.BASE_URL): string {
  if (!hashRoutesEnabled(base)) return url;
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  const prefix = appBasePath(base);
  if (url === prefix || url.startsWith(`${prefix}#`)) return url;
  return `${prefix}#${url}`;
}

export function assignAppLocation(url: string): void {
  window.location.assign(toAppDocument(url));
}

/** The public homepage on this host. A console under a path still opens the site root. */
export function siteHomeHref(origin: string): string {
  return new URL("/", origin).href;
}

/** App icon served with the console, including when the console is not at `/`. */
export function brandIconSrc(base: string | undefined = "/"): string {
  const prefix = !base || base === "/" ? "/" : base.endsWith("/") ? base : `${base}/`;
  return `${prefix}icon-192.png`;
}

/** Rewrite the route's query and return the address a redirect should come back to. */
export function withRouteSearch(
  update: (params: URLSearchParams) => void,
  loc: Address = window.location,
  base = import.meta.env.BASE_URL,
): string {
  if (!hashRoutesEnabled(base)) {
    const url = new URL(loc.href);
    update(url.searchParams);
    return url.href;
  }
  const route = new URL(`${documentPath(loc, base)}${routeSearch(loc, base)}`, loc.origin);
  update(route.searchParams);
  return `${loc.origin}${appBasePath(base)}#${route.pathname}${route.search}`;
}
