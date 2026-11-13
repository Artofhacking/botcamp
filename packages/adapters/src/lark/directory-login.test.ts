import { afterEach, describe, expect, it, vi } from "vitest";
import { directoryLoginScopes } from "./directory-cli-scopes.js";
import {
  directoryLoginEndpoints,
  directoryLoginProfile,
  exchangeDirectoryAuthorizationCode,
  refreshDirectoryAccessToken,
} from "./directory-login.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("directory login endpoints", () => {
  it("uses the Feishu hosts by default and the Lark hosts when asked", () => {
    expect(directoryLoginEndpoints(undefined)?.issuer).toBe("https://accounts.feishu.cn");
    expect(directoryLoginEndpoints(" Lark ")?.tokenUrl).toBe(
      "https://open.larksuite.com/open-apis/authen/v2/oauth/token",
    );
    expect(directoryLoginEndpoints("other")).toBeNull();
  });
});

describe("directory authorization code exchange", () => {
  it("posts the code and verifier and keeps the access token", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          code: 0,
          access_token: "access-token",
          expires_in: 7200,
          refresh_token: "refresh-token",
          token_type: "Bearer",
        });
      }),
    );
    await expect(
      exchangeDirectoryAuthorizationCode({
        tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        clientId: "cli-test",
        clientSecret: "secret",
        code: "auth-code",
        redirectURI: "https://app.example.test/api/auth/callback/directory",
        codeVerifier: "verifier",
      }),
    ).resolves.toEqual({
      accessToken: "access-token",
      expiresIn: 7200,
      refreshToken: "refresh-token",
    });
    expect(bodies[0]).toMatchObject({
      grant_type: "authorization_code",
      client_id: "cli-test",
      code: "auth-code",
      code_verifier: "verifier",
    });
  });

  it("refreshes with the stored token and keeps a rotated refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          code: 0,
          access_token: "next-access",
          expires_in: 7200,
          refresh_token: "next-refresh",
          refresh_token_expires_in: 2592000,
          scope: "calendar:calendar:read offline_access",
        }),
      ),
    );
    await expect(
      refreshDirectoryAccessToken({
        tokenUrl: "https://open.feishu.cn/token",
        clientId: "cli-test",
        clientSecret: "secret",
        refreshToken: "refresh-token",
      }),
    ).resolves.toEqual({
      tokens: {
        accessToken: "next-access",
        expiresIn: 7200,
        refreshToken: "next-refresh",
        refreshExpiresIn: 2592000,
        scopes: ["calendar:calendar:read", "offline_access"],
      },
    });
  });

  it("rejects a provider error without exposing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 20014, msg: "expired" })),
    );
    await expect(
      exchangeDirectoryAuthorizationCode({
        tokenUrl: "https://open.feishu.cn/token",
        clientId: "cli-test",
        clientSecret: "secret",
        code: "auth-code",
        redirectURI: "https://app.example.test/callback",
      }),
    ).resolves.toBeNull();
    await expect(
      refreshDirectoryAccessToken({
        tokenUrl: "https://open.feishu.cn/token",
        clientId: "cli-test",
        clientSecret: "secret",
        refreshToken: "refresh-token",
      }),
    ).resolves.toEqual({ rejected: true });
  });
});

describe("directory login scopes", () => {
  it("asks for the command-line user scopes and the identity scopes together", () => {
    const scopes = directoryLoginScopes(["extra:scope", "offline_access"]);
    expect(scopes).toContain("contact:user.email:readonly");
    expect(scopes).toContain("contact:user.employee:readonly");
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("calendar:calendar:read");
    expect(scopes).toContain("extra:scope");
    expect(scopes.filter((scope) => scope === "offline_access")).toHaveLength(1);
    expect(scopes).not.toContain("im:message.send_as_user");
    expect(scopes.join(" ").length).toBeLessThan(7_500);
  });
});

describe("directory login profile", () => {
  it("prefers the enterprise mailbox and keeps the application subject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          code: 0,
          data: {
            open_id: "ou-person",
            email: "personal@example.test",
            enterprise_email: "person@company.test",
            name: "Person",
            avatar_url: "https://cdn.example.test/person.png",
            tenant_key: "tenant-1",
          },
        }),
      ),
    );
    await expect(
      directoryLoginProfile("https://open.feishu.cn/user", "access-token", "tenant-1"),
    ).resolves.toEqual({
      sub: "ou-person",
      email: "person@company.test",
      name: "Person",
      image: "https://cdn.example.test/person.png",
    });
  });

  it("drops a picture that is not a plain HTTPS URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          code: 0,
          data: {
            open_id: "ou-person",
            email: "person@company.test",
            avatar_url: "http://cdn.example.test/person.png",
          },
        }),
      ),
    );
    await expect(
      directoryLoginProfile("https://open.feishu.cn/user", "access-token"),
    ).resolves.toEqual({ sub: "ou-person", email: "person@company.test" });
  });

  it("refuses another organization, a missing mailbox, and a broken token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ code: 0, data: { open_id: "ou-person", email: "person@company.test" } }),
      ),
    );
    await expect(
      directoryLoginProfile("https://open.feishu.cn/user", "access-token", "tenant-1"),
    ).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 0, data: { open_id: "ou-person" } })),
    );
    await expect(
      directoryLoginProfile("https://open.feishu.cn/user", "access-token"),
    ).resolves.toBeNull();
    await expect(
      directoryLoginProfile("https://open.feishu.cn/user", "bad\ntoken"),
    ).resolves.toBeNull();
  });
});
