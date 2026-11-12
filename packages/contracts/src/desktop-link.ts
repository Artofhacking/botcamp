/** The desktop app's return scheme. The API already trusts this origin. */
export const DESKTOP_APP_PROTOCOL = "rakazo:";

export type DesktopDeepLink =
  | {
      kind: "sso";
      nonce: string;
      returnTo: string;
      /** Signed session bearer from the system browser's auth redirect. */
      token?: string;
      error?: string;
    }
  | { kind: "mcp-oauth"; state: string; code?: string; error?: string }
  | { kind: "slack-install"; state: string; code?: string; error?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(url: URL, name: string, max: number): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return undefined;
  const value = values[0]?.trim() ?? "";
  if (values.length !== 1 || !value || value.length > max) return undefined;
  return value;
}

/** The session cookie Better Auth appends to a non-HTTP redirect. */
export function sessionTokenFromSetCookie(header: string): string | null {
  if (header.length > 8_192) return null;
  const match = header.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.session_token=([^;,\s]+)/);
  const token = match?.[1];
  if (!token || token.length > 4_096 || !token.includes(".")) return null;
  try {
    return decodeURIComponent(token);
  } catch {
    return null;
  }
}

/**
 * A `rakazo://` return from the system browser. Anything else is ignored, including
 * extra query fields, so a link cannot carry a payload the app did not ask for.
 */
export function parseDesktopDeepLink(value: string): DesktopDeepLink | null {
  if (value.length > 16_384) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== DESKTOP_APP_PROTOCOL || url.username || url.password) return null;
  if (url.hostname === "sso") {
    const nonce = one(url, "nonce", 36);
    const returnTo = one(url, "returnTo", 2_048);
    if (!nonce || !UUID.test(nonce) || !returnTo) return null;
    try {
      const target = new URL(returnTo);
      if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    } catch {
      return null;
    }
    const error = one(url, "error", 200);
    if (url.searchParams.has("error") && !error) return null;
    let token: string | undefined;
    if (url.searchParams.has("cookie")) {
      const cookie = one(url, "cookie", 8_192);
      const extracted = cookie ? sessionTokenFromSetCookie(cookie) : null;
      if (!extracted) return null;
      token = extracted;
    }
    return {
      kind: "sso",
      nonce,
      returnTo,
      ...(token ? { token } : {}),
      ...(error ? { error } : {}),
    };
  }
  if (url.hostname !== "mcp-oauth" && url.hostname !== "slack-install") return null;
  const state = one(url, "state", 200);
  if (!state) return null;
  const code = one(url, "code", 2_048);
  const error = one(url, "error", 200);
  if (url.searchParams.has("code") && !code) return null;
  if (url.searchParams.has("error") && !error) return null;
  if (!code && !error) return null;
  return {
    kind: url.hostname,
    state,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  };
}

/** Where desktop SSO asks the provider to return, so the OS opens this app. */
export function ssoDesktopCallback(nonce: string, returnTo: string): string {
  const url = new URL("rakazo://sso");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("returnTo", returnTo);
  return url.href;
}

/** The system-browser callback page hands code and state to the desktop app. */
export function desktopAppReturnUrl(
  kind: "mcp-oauth" | "slack-install",
  params: { get(name: string): string | null },
): string | null {
  const url = new URL(`rakazo://${kind}`);
  for (const name of ["state", "code", "error"] as const) {
    const value = params.get(name);
    if (value) url.searchParams.set(name, value);
  }
  return parseDesktopDeepLink(url.href) ? url.href : null;
}
