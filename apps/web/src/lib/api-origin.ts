/**
 * Where the API lives. A static deployment can serve the app from one host and the API from
 * another by setting `window.__RAKAZO_API_ORIGIN__` in `config.js`; by default the app talks
 * to its own origin, which is what a single-server deployment needs.
 */
declare global {
  interface Window {
    __RAKAZO_API_ORIGIN__?: string;
  }
}

export function apiOrigin(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:5173";
  const injected = window.__RAKAZO_API_ORIGIN__;
  if (typeof injected === "string" && injected.trim()) {
    return injected.trim().replace(/\/+$/, "");
  }
  return window.location.origin;
}

/** An absolute URL for an API path such as `/api/auth/capabilities`. */
export function apiUrl(path: string): string {
  return `${apiOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
