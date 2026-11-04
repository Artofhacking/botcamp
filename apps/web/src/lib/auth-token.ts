/**
 * The session token lives here instead of a cookie, because the app is served from one site
 * and the API from another: browsers drop third-party cookies, and Safari refuses outright.
 *
 * The backend's bearer plugin turns `Authorization: Bearer <token>` into a session, so every
 * request that needs auth sends this header.
 */
const TOKEN_KEY = "bc_auth_token";

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null | undefined): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // A locked-down browser without storage simply keeps the session in memory only.
  }
}

export function clearAuthToken(): void {
  setAuthToken(null);
}

/** Headers for a request that must be authenticated. */
export function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = getAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

/** Remembers the token Better Auth returns with a sign-in response. */
export function captureAuthToken(response: Response): void {
  const token = response.headers.get("set-auth-token");
  if (token) setAuthToken(token);
}
