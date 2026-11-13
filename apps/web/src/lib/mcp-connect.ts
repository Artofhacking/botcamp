import { newClientId } from "@botcamp/core";
import { desktopBridge } from "./desktop";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc } from "./rpc";

export { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

export type McpOauthPasteRequest = {
  sessionId: string;
  authorizationUrl: string;
};

/** Resolves with the callback address, or nothing when the person cancels. */
export type McpOauthPaste = (request: McpOauthPasteRequest) => Promise<string | undefined>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The code and state from a loopback callback URL, or from `code#state`. */
export function mcpOauthCodeFromPaste(
  value: string,
  expectedState: string,
): { code: string; state: string } | undefined {
  const text = value.trim();
  if (!text || text.length > 8_192 || !expectedState) return undefined;
  try {
    const url = new URL(text);
    const code = url.searchParams.get("code")?.trim();
    const state = url.searchParams.get("state")?.trim();
    if (code && state === expectedState) return { code, state };
  } catch {
    // A pasted code uses the compact form instead of a URL.
  }
  const split = text.split("#");
  if (split.length === 2 && split[0] && split[1] === expectedState) {
    return { code: split[0], state: split[1] };
  }
  return undefined;
}

function loopbackRedirect(authorizationUrl: string): boolean {
  try {
    const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");
    if (!redirect) return false;
    const url = new URL(redirect);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Where providers send the user back. The server allows this origin's
 * `/mcp/oauth/callback` and a fragment is not a valid redirect URI, so a console
 * mounted under `/console/` is opened by the site page at this path. */
export function mcpOAuthRedirectUri(origin = window.location.origin): string {
  return new URL("/mcp/oauth/callback", origin).toString();
}

/**
 * QQ Mail sends the code to a loopback address. The desktop app listens there.
 * A browser cannot, so the person pastes the address the browser was sent to.
 */
async function finishLoopbackOauth(
  sessionId: string,
  authorizationUrl: string,
  paste?: McpOauthPaste,
  signal?: AbortSignal,
): Promise<McpOauthResult> {
  if (signal?.aborted) return "cancelled";
  const browserAuth = desktopBridge()?.oauth;
  if (browserAuth?.open) {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      let timeout = 0;
      const finish = (result: McpOauthResult) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        void browserAuth.cancel?.(authorizationUrl).catch(() => undefined);
        resolve(result);
      };
      const onAbort = () => finish("cancelled");
      unsubscribe = browserAuth.onCallback((callback) => {
        if (callback.state !== sessionId || !callback.code) return;
        void rpc.mcp.oauth
          .complete({ sessionId, code: callback.code, state: callback.state })
          .then(() => finish("connected"))
          .catch(() => finish("cancelled"));
      });
      timeout = window.setTimeout(() => finish("cancelled"), MCP_OAUTH_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        finish("cancelled");
        return;
      }
      void browserAuth.open?.(authorizationUrl).catch((error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }
  const popup = window.open(authorizationUrl, MCP_OAUTH_CHANNEL, "popup,width=560,height=720");
  const pasted = paste
    ? await paste({ sessionId, authorizationUrl })
    : (window.prompt("Paste the callback address") ?? undefined);
  popup?.close();
  const text = pasted?.trim();
  if (!text) return "cancelled";
  const parsed = mcpOauthCodeFromPaste(text, sessionId);
  if (!parsed) throw new Error("That address has no authorization code");
  await rpc.mcp.oauth.complete({ sessionId, code: parsed.code, state: parsed.state });
  return "connected";
}

/** Desktop uses the system browser. Older desktops still use a same-session popup. */
export async function connectMcpOauth(
  serverId: string,
  scope?: string,
  paste?: McpOauthPaste,
  signal?: AbortSignal,
): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: mcpOAuthRedirectUri(),
    ...(scope ? { scope } : {}),
  });
  if (signal?.aborted) return "cancelled";
  if (started.status !== "authorization_required") return started.status;
  if (loopbackRedirect(started.authorizationUrl)) {
    return finishLoopbackOauth(started.sessionId, started.authorizationUrl, paste, signal);
  }
  const popup = window.open(
    started.authorizationUrl,
    MCP_OAUTH_CHANNEL,
    "popup,width=560,height=720",
  );
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
    window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
    // COOP makes an open popup read as closed, but it keeps focus until the
    // user really closes it.
    pollTimer = window.setInterval(() => {
      if (popup.closed && document.hasFocus()) finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      finish("connected");
    };
  });
}

/** Connect one built-in app's MCP server, creating the row the first time. */
export async function connectBuiltinApp(
  app: { name: string; endpoint: string },
  options: {
    scope?: string;
    paste?: McpOauthPaste;
    botId?: string;
    threadId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<McpOauthResult> {
  const servers = await rpc.mcp.servers.list();
  const existing = servers.find((server) => !server.installId && server.endpoint === app.endpoint);
  const server =
    existing ??
    (await rpc.mcp.servers.create({
      slug: `integration-${newClientId().slice(0, 8)}`,
      name: app.name,
      transport: "streamable_http",
      endpoint: app.endpoint,
    }));
  const result = await connectMcpOauth(server.id, options.scope, options.paste, options.signal);
  if ((result === "connected" || result === "already_connected") && options.botId) {
    await rpc.mcp.assignments.approve({
      botId: options.botId,
      serverId: server.id,
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
  }
  return result;
}
