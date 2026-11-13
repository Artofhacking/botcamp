import { describe, expect, it, vi } from "vitest";
import { McpOAuthBroker, StoredMcpOAuthProvider } from "./mcp-oauth.js";
import {
  isQqMailMcpEndpoint,
  mcpOAuthRedirectFor,
  QQ_MAIL_MCP_ENDPOINT,
  QQ_MAIL_OAUTH_CLIENT_NAME,
  QQ_MAIL_OAUTH_REDIRECT,
} from "./qq-mail-oauth.js";

describe("QQ Mail OAuth admission", () => {
  it("keeps the public callback for every server except QQ Mail", () => {
    expect(isQqMailMcpEndpoint(QQ_MAIL_MCP_ENDPOINT)).toBe(true);
    expect(isQqMailMcpEndpoint("https://api.mail.qq.com/mcp/")).toBe(true);
    expect(isQqMailMcpEndpoint("https://mcp.notion.com/mcp")).toBe(false);
    expect(mcpOAuthRedirectFor("https://mcp.notion.com/mcp", "https://app.example/callback")).toBe(
      "https://app.example/callback",
    );
    expect(mcpOAuthRedirectFor(QQ_MAIL_MCP_ENDPOINT, "https://app.example/callback")).toBe(
      QQ_MAIL_OAUTH_REDIRECT,
    );
  });

  it("registers the trusted client name against the loopback callback", () => {
    const provider = new StoredMcpOAuthProvider("server-1", {}, async () => undefined, {
      redirectUri: QQ_MAIL_OAUTH_REDIRECT,
      clientName: QQ_MAIL_OAUTH_CLIENT_NAME,
    });
    expect(provider.clientMetadata).toMatchObject({
      client_name: "OpenClaw",
      redirect_uris: [QQ_MAIL_OAUTH_REDIRECT],
      application_type: "native",
    });
  });
});

it("sends QQ Mail registration to the loopback callback under the trusted name", async () => {
  let registration: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = request.url;
      if (url === `${QQ_MAIL_MCP_ENDPOINT}` && request.method === "POST") {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${QQ_MAIL_MCP_ENDPOINT.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (url === "https://api.mail.qq.com/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: QQ_MAIL_MCP_ENDPOINT,
          authorization_servers: ["https://wx.mail.qq.com"],
        });
      }
      if (url === "https://wx.mail.qq.com/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://wx.mail.qq.com",
          authorization_endpoint: "https://wx.mail.qq.com/oauth/authorize",
          token_endpoint: "https://wx.mail.qq.com/oauth/token",
          registration_endpoint: "https://wx.mail.qq.com/oauth/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://wx.mail.qq.com/oauth/register" && request.method === "POST") {
        registration = (await request.json()) as Record<string, unknown>;
        return Response.json({
          client_id: "registered-client-id",
          redirect_uris: registration.redirect_uris,
          token_endpoint_auth_method: "none",
        });
      }
      throw new Error(`Unexpected request: ${request.method} ${url}`);
    }),
  );
  const prisma = {
    mcpServer: {
      findFirst: vi.fn().mockResolvedValue({
        id: "server-1",
        endpoint: QQ_MAIL_MCP_ENDPOINT,
        secretId: null,
        enabled: true,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    mcpOAuthSession: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    deploymentSettings: { findUnique: vi.fn(async () => ({ ownerUserId: "user-1" })) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        $executeRaw: vi.fn().mockResolvedValue(1),
        $queryRaw: vi.fn().mockResolvedValue([]),
        mcpServer: {
          findFirst: vi.fn().mockResolvedValue({
            endpoint: QQ_MAIL_MCP_ENDPOINT,
            secretId: null,
          }),
          update: vi.fn().mockResolvedValue({}),
        },
        secret: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      }),
    ),
  };
  const broker = new McpOAuthBroker(
    prisma as never,
    { put: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })) } as never,
    {
      fetch: (input, init) => globalThis.fetch(input, init),
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    },
  );
  const started = await broker.begin({
    serverId: "server-1",
    spaceId: "workspace-1",
    userId: "user-1",
    redirectUri: "https://app.example/mcp/oauth/callback",
    scope: "alias:read mail:read",
  });
  expect(started.status).toBe("authorization_required");
  if (started.status !== "authorization_required") return;
  expect(registration).toMatchObject({
    client_name: "OpenClaw",
    redirect_uris: [QQ_MAIL_OAUTH_REDIRECT],
    application_type: "native",
  });
  const authorization = new URL(started.authorizationUrl);
  expect(authorization.searchParams.get("redirect_uri")).toBe(QQ_MAIL_OAUTH_REDIRECT);
  expect(authorization.searchParams.get("state")).toBe(started.sessionId);
  expect(prisma.mcpOAuthSession.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ redirectUri: QQ_MAIL_OAUTH_REDIRECT }),
  });
});
