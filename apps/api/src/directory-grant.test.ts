import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectoryGrant, directoryRuntime } from "./directory-grant.js";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("@botcamp/adapters/lark-directory-login", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@botcamp/adapters/lark-directory-login")>();
  return { ...actual, refreshDirectoryAccessToken: refresh };
});

const key = "offline-test-secret-with-at-least-32-characters";
const directory = {
  clientId: "cli-test",
  clientSecret: "login-secret",
  tokenUrl: "https://open.example.test/token",
  brand: "feishu" as const,
};

afterEach(() => {
  refresh.mockReset();
});

describe("directory grant", () => {
  it("uses a fresh access token without calling the refresh endpoint", async () => {
    const prisma = {
      account: {
        findFirst: vi.fn(async () => ({
          id: "account-1",
          accessToken: "plain-access",
          refreshToken: "plain-refresh",
          accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
        })),
        updateMany: vi.fn(),
      },
    };
    const grant = createDirectoryGrant({ prisma: prisma as never, key, directory });
    await expect(grant.openGrant("user-1")).resolves.toMatchObject({ accessToken: "plain-access" });
    expect(refresh).not.toHaveBeenCalled();
    expect(await grant.linked("user-1")).toBe(true);
  });

  it("stores the rotated refresh token and reports a rejected grant", async () => {
    const stored = {
      id: "account-1",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    };
    let saved: { accessToken?: string; refreshToken?: string } | undefined;
    const prisma = {
      account: {
        findFirst: vi.fn(async () => stored),
        updateMany: vi.fn(async (args: { data: { accessToken: string; refreshToken: string } }) => {
          saved = args.data;
          return { count: 1 };
        }),
      },
    };
    refresh.mockResolvedValueOnce({
      tokens: {
        accessToken: "next-access",
        expiresIn: 7200,
        refreshToken: "next-refresh",
        refreshExpiresIn: 2592000,
        scopes: ["calendar:calendar:read"],
      },
    });
    const grant = createDirectoryGrant({ prisma: prisma as never, key, directory });
    await expect(grant.openGrant("user-1")).resolves.toMatchObject({
      accessToken: "next-access",
      appId: "cli-test",
    });
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "login-secret", refreshToken: "old-refresh" }),
    );
    expect(prisma.account.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "account-1", refreshToken: "old-refresh" },
      }),
    );
    expect(saved?.accessToken).toBeTruthy();
    expect(saved?.accessToken).not.toBe("next-access");
    expect(saved?.refreshToken).not.toBe("next-refresh");

    refresh.mockResolvedValueOnce({ rejected: true });
    stored.accessTokenExpiresAt = new Date(Date.now() - 1000);
    await expect(grant.openGrant("user-1")).resolves.toEqual({ error: "needs_consent" });
  });

  it("reads the login client only when both settings are present", () => {
    expect(directoryRuntime({})).toBeUndefined();
    expect(directoryRuntime({ LARK_LOGIN_APP_ID: "cli-test" })).toBeUndefined();
    expect(
      directoryRuntime({
        LARK_LOGIN_APP_ID: "cli-test",
        LARK_LOGIN_APP_SECRET: "login-secret",
      }),
    ).toMatchObject({
      clientId: "cli-test",
      tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      brand: "feishu",
    });
  });
});
