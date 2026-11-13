/** Official QQ Mail MCP. Tencent admits dynamic registration only for a trusted client name. */
export const QQ_MAIL_MCP_ENDPOINT = "https://api.mail.qq.com/mcp";

/**
 * Loopback callback Tencent accepts for that client. Port 53692 is the model
 * sign-in listener, so this grant uses its own port.
 */
export const QQ_MAIL_OAUTH_REDIRECT = "http://127.0.0.1:47631/callback";

/** The client name Tencent's registration endpoint accepts for the loopback callback. */
export const QQ_MAIL_OAUTH_CLIENT_NAME = "OpenClaw";

export function isQqMailMcpEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      url.host === "api.mail.qq.com" &&
      url.pathname.replace(/\/$/, "") === "/mcp"
    );
  } catch {
    return false;
  }
}

/** QQ Mail ignores a public callback. Every other server keeps the redirect it asked for. */
export function mcpOAuthRedirectFor(
  endpoint: string | null | undefined,
  requested: string,
): string {
  return isQqMailMcpEndpoint(endpoint) ? QQ_MAIL_OAUTH_REDIRECT : requested;
}
