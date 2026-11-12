import type { SecretStore } from "@botcamp/adapter-kit";
import type { PrismaClient } from "@botcamp/db";
import { describe, expect, it, vi } from "vitest";
import { PersonalChatBridge, PersonalChatError } from "./bridge.js";
import type { FeishuClient, FeishuLogin, FeishuSession } from "./feishu.js";
import { FeishuProtocolError } from "./feishu.js";
import type { IlinkClient } from "./ilink.js";

const actor = { userId: "user-1", spaceId: "space-1" };
const session = {
  token: "token",
  accountId: "acct-1",
  baseUrl: "https://ilinkai.weixin.qq.com",
  userId: "wx-user",
  contextTokens: {},
};

function stores() {
  const created: unknown[] = [];
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", isPrimary: true })) },
    chatToolLink: {
      findFirst: vi.fn(
        async (_args?: {
          where?: { provider?: string };
        }): Promise<{
          id: string;
          ciphertext?: string;
          provider?: string;
          accountId?: string;
        } | null> => null,
      ),
      findMany: vi.fn(
        async (): Promise<Array<{ provider: string; address: string; botId: string }>> => [],
      ),
      create: vi.fn(async (args: { data: unknown }) => {
        created.push(args.data);
        return args.data;
      }),
      delete: vi.fn(async () => ({})),
    },
    messagingIdentity: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async () => ({ id: "identity-1" })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    chatToolLogin: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<void>) => run(prisma)),
  };
  const secrets = {
    put: vi.fn(async () => ({ ciphertext: "sealed" })),
    load: vi.fn(async () => JSON.stringify({ qrcode: "qr", baseUrl: session.baseUrl })),
    delete: vi.fn(async () => undefined),
  };
  return { prisma, secrets, created };
}

function bridge(
  prisma: ReturnType<typeof stores>["prisma"],
  secrets: ReturnType<typeof stores>["secrets"],
  client: Partial<IlinkClient>,
  feishu?: Partial<FeishuClient>,
) {
  return new PersonalChatBridge(
    prisma as unknown as PrismaClient,
    secrets as unknown as SecretStore,
    client as IlinkClient,
    feishu as FeishuClient,
  );
}

describe("one bot, one WeChat", () => {
  it("does not start a second link when that bot already has one", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLink.findFirst.mockResolvedValue({ id: "link-1" });
    const fetchQr = vi.fn();
    const linked = bridge(prisma, secrets, { fetchQr });
    await expect(linked.start(actor, "bot-1", "weixin")).rejects.toBeInstanceOf(PersonalChatError);
    await expect(linked.start(actor, "bot-1", "weixin")).rejects.toMatchObject({
      code: "already_linked",
    });
    expect(fetchQr).not.toHaveBeenCalled();
    expect(prisma.chatToolLink.create).not.toHaveBeenCalled();
  });

  it("does not start a second link when that bot already has a chat identity", async () => {
    const { prisma, secrets } = stores();
    prisma.messagingIdentity.findFirst.mockResolvedValue({ id: "identity-1" });
    const fetchQr = vi.fn();
    await expect(
      bridge(prisma, secrets, { fetchQr }).start(actor, "bot-1", "weixin"),
    ).rejects.toMatchObject({
      code: "already_linked",
    });
    expect(fetchQr).not.toHaveBeenCalled();
  });

  it("does not fetch a code for a chat app that is not offered", async () => {
    const { prisma, secrets } = stores();
    const fetchQr = vi.fn();
    await expect(
      bridge(prisma, secrets, { fetchQr }).start(actor, "bot-1", "telegram"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchQr).not.toHaveBeenCalled();
  });

  it("keeps the first WeChat when a second confirmation loses the unique bot slot", async () => {
    const { prisma, secrets, created } = stores();
    prisma.chatToolLogin.findFirst.mockResolvedValue({
      id: "login-1",
      botId: "bot-1",
      ciphertext: "login-secret",
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.chatToolLink.create.mockRejectedValue({ code: "P2002" });
    const pollQr = vi.fn(async () => ({ kind: "confirmed" as const, session }));
    await expect(
      bridge(prisma, secrets, { pollQr, notify: vi.fn() }).poll(actor, "login-1"),
    ).rejects.toMatchObject({ code: "already_linked" });
    expect(created).toEqual([]);
    expect(prisma.messagingIdentity.create).not.toHaveBeenCalled();
  });

  it("stops before writing when the bot was linked while the code was confirming", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLogin.findFirst.mockResolvedValue({
      id: "login-1",
      botId: "bot-1",
      ciphertext: "login-secret",
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.chatToolLink.findFirst.mockResolvedValue({ id: "link-1" });
    const pollQr = vi.fn(async () => ({ kind: "confirmed" as const, session }));
    await expect(
      bridge(prisma, secrets, { pollQr, notify: vi.fn() }).poll(actor, "login-1"),
    ).rejects.toMatchObject({ code: "already_linked" });
    expect(prisma.chatToolLink.create).not.toHaveBeenCalled();
    expect(prisma.messagingIdentity.create).not.toHaveBeenCalled();
  });
});

const feishuLogin: FeishuLogin = {
  kind: "feishu",
  deviceCode: "device-1",
  domain: "https://accounts.feishu.cn",
  intervalMs: 5_000,
  notBefore: 0,
};

const feishuSession: FeishuSession = {
  kind: "feishu",
  appId: "cli_a1b2c3d4e5f67890",
  appSecret: "secret",
  openBase: "https://open.feishu.cn",
  botOpenId: "ou_bot",
  userOpenId: "ou_user",
};

function feishuLoginRow() {
  return {
    id: "login-1",
    botId: "bot-1",
    provider: "feishu",
    ciphertext: "login-secret",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

describe("one bot, one Feishu", () => {
  it("stores a Feishu confirm page without asking WeChat for a code", async () => {
    const { prisma, secrets } = stores();
    const fetchQr = vi.fn();
    const begin = vi.fn(async () => ({
      login: feishuLogin,
      image: "https://open.feishu.cn/page/cli?user_code=abc",
      expiresInMs: 60_000,
    }));
    const started = await bridge(prisma, secrets, { fetchQr }, { begin }).start(
      actor,
      "bot-1",
      "feishu",
    );
    expect(fetchQr).not.toHaveBeenCalled();
    expect(started.image).toBe("https://open.feishu.cn/page/cli?user_code=abc");
    expect(prisma.chatToolLogin.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: "feishu",
        botId: "bot-1",
        image: "https://open.feishu.cn/page/cli?user_code=abc",
      }),
    });
  });

  it("does not start Feishu when that bot already has Feishu", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLink.findFirst.mockImplementation(async (args) =>
      args?.where?.provider === "feishu" ? { id: "link-1" } : null,
    );
    const begin = vi.fn();
    await expect(
      bridge(prisma, secrets, {}, { begin }).start(actor, "bot-1", "feishu"),
    ).rejects.toMatchObject({ code: "already_linked" });
    expect(begin).not.toHaveBeenCalled();
  });

  it("starts Feishu when that bot already has WeChat", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLink.findFirst.mockImplementation(async (args) =>
      args?.where?.provider === "weixin" ? { id: "link-weixin" } : null,
    );
    prisma.chatToolLink.findMany.mockResolvedValue([
      { provider: "weixin", address: "wx-user", botId: "bot-1" },
    ]);
    const begin = vi.fn(async () => ({
      login: feishuLogin,
      image: "https://open.feishu.cn/page/cli?user_code=abc",
      expiresInMs: 60_000,
    }));
    const linked = bridge(prisma, secrets, {}, { begin });
    await expect(linked.list(actor, "bot-1")).resolves.toEqual([
      { provider: "weixin", address: "wx-user", botId: "bot-1" },
    ]);
    await expect(linked.start(actor, "bot-1", "feishu")).resolves.toMatchObject({
      image: "https://open.feishu.cn/page/cli?user_code=abc",
    });
    expect(begin).toHaveBeenCalled();
  });

  it("removes only the channel that was unlinked", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLink.findFirst.mockImplementation(async (args) =>
      args?.where?.provider === "feishu"
        ? { id: "link-feishu", provider: "feishu", ciphertext: "secret" }
        : null,
    );
    await bridge(prisma, secrets, {}).unlink(actor, "bot-1", "feishu");
    expect(prisma.chatToolLink.delete).toHaveBeenCalledWith({ where: { id: "link-feishu" } });
    expect(prisma.messagingIdentity.deleteMany).toHaveBeenCalledWith({
      where: { botId: "bot-1", provider: "feishu", userId: "user-1" },
    });
  });

  it("links the confirmed person and their app", async () => {
    const { prisma, secrets, created } = stores();
    prisma.chatToolLogin.findFirst.mockResolvedValue(feishuLoginRow());
    secrets.load.mockResolvedValue(JSON.stringify(feishuLogin));
    const poll = vi.fn(async () => ({ kind: "confirmed" as const, session: feishuSession }));
    await expect(bridge(prisma, secrets, {}, { poll }).poll(actor, "login-1")).resolves.toEqual({
      status: "linked",
      link: { provider: "feishu", address: "ou_user", botId: "bot-1" },
    });
    expect(created).toEqual([
      expect.objectContaining({
        provider: "feishu",
        accountId: feishuSession.appId,
        address: "ou_user",
        botId: "bot-1",
      }),
    ]);
    expect(prisma.messagingIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        provider: "feishu",
        address: "ou_user",
        dmThreadId: `feishu:${feishuSession.appId}:ou_user`,
        botId: "bot-1",
      }),
    });
  });

  it("keeps the app linked when the person's id arrives with their first message", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLogin.findFirst.mockResolvedValue(feishuLoginRow());
    secrets.load.mockResolvedValue(JSON.stringify(feishuLogin));
    const poll = vi.fn(async () => ({
      kind: "confirmed" as const,
      session: { ...feishuSession, userOpenId: "" },
    }));
    await expect(bridge(prisma, secrets, {}, { poll }).poll(actor, "login-1")).resolves.toEqual({
      status: "linked",
      link: { provider: "feishu", address: feishuSession.appId, botId: "bot-1" },
    });
    expect(prisma.messagingIdentity.create).not.toHaveBeenCalled();
  });

  it("remembers a longer wait without rewriting an unchanged login", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLogin.findFirst.mockResolvedValue(feishuLoginRow());
    secrets.load.mockResolvedValue(JSON.stringify(feishuLogin));
    const waiting = { ...feishuLogin, notBefore: Date.now() + 10_000 };
    const poll = vi.fn(async () => ({ kind: "wait" as const, login: waiting }));
    await expect(bridge(prisma, secrets, {}, { poll }).poll(actor, "login-1")).resolves.toEqual({
      status: "wait",
    });
    expect(prisma.chatToolLogin.updateMany).toHaveBeenCalled();

    secrets.load.mockResolvedValue(JSON.stringify(waiting));
    prisma.chatToolLogin.updateMany.mockClear();
    const same = vi.fn(async (saved: FeishuLogin) => ({ kind: "wait" as const, login: saved }));
    await bridge(prisma, secrets, {}, { poll: same }).poll(actor, "login-1");
    expect(prisma.chatToolLogin.updateMany).not.toHaveBeenCalled();
  });

  it("reports a protocol failure as the chat app being unavailable", async () => {
    const { prisma, secrets } = stores();
    const begin = vi.fn(async () => {
      throw new FeishuProtocolError("down");
    });
    await expect(
      bridge(prisma, secrets, {}, { begin }).start(actor, "bot-1", "feishu"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(prisma.chatToolLogin.create).not.toHaveBeenCalled();
  });

  it("sends a reply through the linked Feishu app", async () => {
    const { prisma, secrets } = stores();
    prisma.chatToolLink.findFirst.mockResolvedValue({
      id: "link-1",
      ciphertext: "secret",
      provider: "feishu",
      accountId: feishuSession.appId,
    });
    secrets.load.mockResolvedValue(JSON.stringify(feishuSession));
    const sendText = vi.fn(async () => "om_sent");
    const sendWeChat = vi.fn();
    await expect(
      bridge(prisma, secrets, { sendText: sendWeChat }, { sendText }).send(
        `feishu:${feishuSession.appId}:ou_user`,
        "hello",
      ),
    ).resolves.toEqual({ handle: "om_sent" });
    expect(sendWeChat).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ appId: feishuSession.appId, userOpenId: "ou_user" }),
      "ou_user",
      "hello",
    );
  });
});
