import type { DesktopDeepLink } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, mcpOAuthRedirectUri } from "./mcp-connect";

const mcp = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  list: vi.fn(),
}));
vi.mock("./rpc", () => ({
  rpc: {
    mcp: {
      oauth: { begin: mcp.begin, complete: mcp.complete },
      servers: { list: mcp.list },
    },
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mcp.begin.mockReset();
  mcp.complete.mockReset();
  mcp.list.mockReset();
});

function desktopLinks() {
  const listeners = new Set<(link: DesktopDeepLink) => void>();
  const open = vi.fn(async () => undefined);
  vi.stubGlobal("window", {
    location: { origin: "https://rakazo.example.test", href: "https://rakazo.example.test/app" },
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (...args: Parameters<typeof clearInterval>) => clearInterval(...args),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    rakazoDesktop: {
      links: {
        open,
        onUrl: (listener: (link: DesktopDeepLink) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  return {
    open,
    emit: (link: DesktopDeepLink) => {
      for (const listener of listeners) listener(link);
    },
  };
}

const started = {
  status: "authorization_required" as const,
  sessionId: "session-1",
  authorizationUrl: "https://mcp.example.test/authorize",
};

describe("mcpOAuthRedirectUri", () => {
  it("uses the origin callback the server allows", () => {
    expect(mcpOAuthRedirectUri("https://botcamp.example")).toBe(
      "https://botcamp.example/mcp/oauth/callback",
    );
  });
});

it("completes MCP OAuth from the system-browser return", async () => {
  mcp.begin.mockResolvedValue(started);
  mcp.complete.mockResolvedValue({ ok: true });
  mcp.list.mockResolvedValue([{ id: "srv", oauthStatus: "none" }]);
  const { open, emit } = desktopLinks();
  const flow = connectMcpOauth("srv");
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith(started.authorizationUrl));
  emit({ kind: "mcp-oauth", state: "other", code: "nope" });
  expect(mcp.complete).not.toHaveBeenCalled();
  emit({ kind: "mcp-oauth", state: started.sessionId, code: "auth-code" });
  await expect(flow).resolves.toBe("connected");
  expect(mcp.complete).toHaveBeenCalledWith({
    sessionId: started.sessionId,
    code: "auth-code",
    state: started.sessionId,
  });
});

it("treats a status change to connected as a finished MCP grant", async () => {
  vi.useFakeTimers();
  mcp.begin.mockResolvedValue(started);
  mcp.list
    .mockResolvedValueOnce([{ id: "srv", oauthStatus: "reconnect" }])
    .mockResolvedValue([{ id: "srv", oauthStatus: "connected" }]);
  const { open } = desktopLinks();
  const flow = connectMcpOauth("srv");
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledWith(started.authorizationUrl);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(flow).resolves.toBe("connected");
  expect(mcp.complete).not.toHaveBeenCalled();
});

it("does not treat an already connected MCP server as a new grant", async () => {
  vi.useFakeTimers();
  mcp.begin.mockResolvedValue(started);
  mcp.complete.mockResolvedValue({ ok: true });
  mcp.list.mockResolvedValue([{ id: "srv", oauthStatus: "connected" }]);
  const { emit } = desktopLinks();
  const flow = connectMcpOauth("srv");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(mcp.complete).not.toHaveBeenCalled();
  emit({ kind: "mcp-oauth", state: started.sessionId, code: "auth-code" });
  await expect(flow).resolves.toBe("connected");
});
