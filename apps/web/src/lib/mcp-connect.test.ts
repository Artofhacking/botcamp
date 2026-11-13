import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpOauth, mcpOAuthRedirectUri, mcpOauthCodeFromPaste } from "./mcp-connect";

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

it("reads a loopback callback address only when its state matches", () => {
  const address = "http://127.0.0.1:47631/callback?code=auth-code&state=session-1";
  expect(mcpOauthCodeFromPaste(address, "session-1")).toEqual({
    code: "auth-code",
    state: "session-1",
  });
  expect(mcpOauthCodeFromPaste("auth-code#session-1", "session-1")).toEqual({
    code: "auth-code",
    state: "session-1",
  });
  expect(mcpOauthCodeFromPaste(address, "other")).toBeUndefined();
  expect(mcpOauthCodeFromPaste("auth-code", "session-1")).toBeUndefined();
});

it("cancels a loopback grant when the attempt is aborted", async () => {
  const authorizationUrl =
    "https://wx.mail.qq.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A47631%2Fcallback&state=session-1";
  mcp.begin.mockResolvedValue({ ...started, sessionId: "session-1", authorizationUrl });
  const open = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  vi.stubGlobal("window", {
    location: { origin: "https://rakazo.example.test" },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    rakazoDesktop: {
      oauth: {
        open,
        cancel,
        onCallback: () => () => undefined,
      },
    },
  });
  const controller = new AbortController();
  const flow = connectMcpOauth("srv", undefined, undefined, controller.signal);
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith(authorizationUrl));
  controller.abort();
  await expect(flow).resolves.toBe("cancelled");
  expect(cancel).toHaveBeenCalledWith(authorizationUrl);
});

it("finishes a loopback grant from the desktop listener", async () => {
  const authorizationUrl =
    "https://wx.mail.qq.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A47631%2Fcallback&state=session-1";
  mcp.begin.mockResolvedValue({ ...started, sessionId: "session-1", authorizationUrl });
  mcp.complete.mockResolvedValue({ ok: true });
  const listeners = new Set<(callback: { code: string; state?: string }) => void>();
  const open = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  vi.stubGlobal("window", {
    location: { origin: "https://rakazo.example.test" },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    rakazoDesktop: {
      oauth: {
        open,
        cancel,
        onCallback: (listener: (callback: { code: string; state?: string }) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  const flow = connectMcpOauth("srv");
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith(authorizationUrl));
  for (const listener of listeners) listener({ code: "auth-code", state: "session-1" });
  await expect(flow).resolves.toBe("connected");
  expect(mcp.complete).toHaveBeenCalledWith({
    sessionId: "session-1",
    code: "auth-code",
    state: "session-1",
  });
  expect(cancel).toHaveBeenCalledWith(authorizationUrl);
});
