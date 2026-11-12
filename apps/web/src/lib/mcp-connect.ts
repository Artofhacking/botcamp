import type { DesktopDeepLink } from "@rakazo/contracts";
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

/** Where providers send the user back. The server allows this origin's
 * `/mcp/oauth/callback` and a fragment is not a valid redirect URI, so a console
 * mounted under `/console/` is opened by the site page at this path. */
export function mcpOAuthRedirectUri(origin = window.location.origin): string {
  return new URL("/mcp/oauth/callback", origin).toString();
}

async function connectMcpOauthInSystemBrowser(
  serverId: string,
  sessionId: string,
  authorizationUrl: string,
  links: NonNullable<NonNullable<ReturnType<typeof desktopBridge>>["links"]>,
): Promise<McpOauthResult> {
  const before = await rpc.mcp.servers.list().catch(() => []);
  const initial = before.find((server) => server.id === serverId)?.oauthStatus;
  await links.open(authorizationUrl);
  return await new Promise<McpOauthResult>((resolve) => {
    let settled = false;
    let statusTimer = 0;
    let timeoutTimer = 0;
    let unsubscribe: () => void = () => undefined;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(statusTimer);
      window.clearTimeout(timeoutTimer);
      unsubscribe();
      resolve(result);
    };
    unsubscribe = links.onUrl((link: DesktopDeepLink) => {
      if (link.kind !== "mcp-oauth" || link.state !== sessionId || !link.code) return;
      void rpc.mcp.oauth
        .complete({ sessionId, code: link.code, state: link.state })
        .then(() => finish("connected"))
        .catch(() => undefined);
    });
    // The website may finish the grant itself when that browser is already signed in.
    statusTimer = window.setInterval(() => {
      void rpc.mcp.servers
        .list()
        .then((servers) => {
          const status = servers.find((server) => server.id === serverId)?.oauthStatus;
          if (status === "connected" && initial !== "connected") finish("connected");
        })
        .catch(() => undefined);
    }, 2_000);
    timeoutTimer = window.setTimeout(() => finish("cancelled"), MCP_OAUTH_TIMEOUT_MS);
  });
}

/** Desktop uses the system browser. Older desktops still use a same-session popup. */
export async function connectMcpOauth(serverId: string, scope?: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({
    serverId,
    redirectUri: mcpOAuthRedirectUri(),
    ...(scope ? { scope } : {}),
  });
  if (started.status !== "authorization_required") return started.status;
  const links = desktopBridge()?.links;
  if (links) {
    return connectMcpOauthInSystemBrowser(
      serverId,
      started.sessionId,
      started.authorizationUrl,
      links,
    );
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
