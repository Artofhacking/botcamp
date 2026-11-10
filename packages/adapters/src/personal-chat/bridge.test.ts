import type { SecretStore } from "@botcamp/adapter-kit";
import type { PrismaClient } from "@botcamp/db";
import { describe, expect, it, vi } from "vitest";
import { PersonalChatBridge, PersonalChatError } from "./bridge.js";
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
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async (args: { data: unknown }) => {
        created.push(args.data);
        return args.data;
      }),
    },
    messagingIdentity: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async () => ({ id: "identity-1" })),
    },
    chatToolLogin: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(),
      delete: vi.fn(async () => ({})),
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
) {
  return new PersonalChatBridge(
    prisma as unknown as PrismaClient,
    secrets as unknown as SecretStore,
    client as IlinkClient,
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
