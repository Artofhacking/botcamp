/**
 * Where the API lives. A static deployment can serve the app from one host and the API from
 * another by setting `window.__BOTCAMP_API_ORIGIN__` in `config.js`; by default the app talks
 * to its own origin, which is what a single-server deployment needs. A page that still sets
 * `__RAKAZO_API_ORIGIN__` is read when the new name is empty.
 */
declare global {
  interface Window {
    __BOTCAMP_API_ORIGIN__?: string;
    __RAKAZO_API_ORIGIN__?: string;
  }
}

export function apiOrigin(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:5173";
  const injected = window.__BOTCAMP_API_ORIGIN__ || window.__RAKAZO_API_ORIGIN__;
  if (typeof injected === "string" && injected.trim()) {
    return injected.trim().replace(/\/+$/, "");
  }
  // A test or embedded frame can expose window without a location. The app then uses the
  // same loopback default as a non-browser run.
  return window.location?.origin || "http://127.0.0.1:5173";
}

/** An absolute URL for an API path such as `/api/auth/capabilities`. */
export function apiUrl(path: string): string {
  return `${apiOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}
