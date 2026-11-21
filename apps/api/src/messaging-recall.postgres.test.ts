import { FakeSandboxProvider } from "@botcamp/adapters";
import type { PrismaClient } from "@botcamp/db";
import { asSystem, createDb, createThreadEvents, provisionMessagingIdentity } from "@botcamp/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMessagingInboundHandler } from "./messaging-inbound.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL
    ? describe.sequential
    : describe.skip;

describePostgres("a chat message the person takes back (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const users: string[] = [];
  const policy = { signupsEnabled: "true", signupAllowlist: undefined };

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function setup() {
    const address = `ou_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const threadId = `feishu:cli_0123456789abcdef:${address}`;
    const ids = await provisionMessagingIdentity(
      prisma,
      { provider: "feishu", address, dmThreadId: threadId, displayName: null },
      policy,
    );
    users.push(ids.userId);
    const deleteMessage = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const inbound = createMessagingInboundHandler({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(async () => undefined), cancel },
      sandbox: new FakeSandboxProvider(),
      provision: (request, env) => provisionMessagingIdentity(prisma, request, env),
      openSignup: false,
      signupPolicy: policy,
      deleteMessage,
    });
    const say = (handle: string, content: string) =>
      inbound({
        type: "message",
        provider: "feishu",
        handle,
        threadId,
        isDirect: true,
        from: address,
        fromLabel: null,
        channelName: null,
        participants: [],
        content,
        mediaUrl: null,
      });
    const recall = (handle: string) =>
      inbound({ type: "recall", provider: "feishu", handle, threadId, from: address });
    const sourceOf = (handle: string) =>
      prisma.message.findUnique({
        where: {
          threadId_clientNonce: {
            threadId: ids.threadId,
            clientNonce: `messaging:feishu:${handle}`,
          },
        },
      });
    return { ids, threadId, say, recall, sourceOf, deleteMessage, cancel };
  }

  it("removes the message and its delivered reply, and takes the reply back in the chat", async () => {
    const { ids, threadId, say, recall, sourceOf, deleteMessage } = await setup();
    await say("om_keep", "earlier");
    // Finished, so the next message starts its own run instead of joining this one.
    const earlier = await sourceOf("om_keep");
    await prisma.run.updateMany({
      where: { sourceMessageId: earlier!.id },
      data: { status: "completed" },
    });
    await say("om_oops", "wrong chat");
    const source = await sourceOf("om_oops");
    const run = await prisma.run.findFirstOrThrow({ where: { sourceMessageId: source!.id } });
    await prisma.run.update({ where: { id: run.id }, data: { status: "completed" } });
    const reply = await prisma.message.create({
      data: {
        threadId: ids.threadId,
        seq: 100,
        role: "bot",
        blocks: [{ kind: "text", text: "on it" }],
        botId: ids.botId,
        runId: run.id,
      },
    });
    await prisma.messagingOutbound.create({
      data: {
        idempotencyKey: `msg:${reply.id}`,
        kind: "dm",
        body: "on it",
        status: "sent",
        providerHandle: "om_reply",
        sourceMessageId: reply.id,
      },
    });

    await recall("om_oops");

    expect(await sourceOf("om_oops")).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: reply.id } })).toBeNull();
    expect(await sourceOf("om_keep")).not.toBeNull();
    expect(deleteMessage).toHaveBeenCalledWith(threadId, "om_reply");
    const deleted = await prisma.event.findFirstOrThrow({
      where: { threadId: ids.threadId, type: "thread.message.deleted" },
    });
    expect(deleted.payload).toEqual({ messageIds: [source!.id, reply.id] });
  });

  it("stops a reply still being written and holds back what was queued", async () => {
    const { ids, say, recall, sourceOf, deleteMessage, cancel } = await setup();
    await say("om_busy", "never mind");
    const source = await sourceOf("om_busy");
    const run = await prisma.run.findFirstOrThrow({ where: { sourceMessageId: source!.id } });
    const reply = await prisma.message.create({
      data: {
        threadId: ids.threadId,
        seq: 100,
        role: "bot",
        blocks: [{ kind: "text", text: "half" }],
        botId: ids.botId,
        runId: run.id,
      },
    });
    const queued = await prisma.messagingOutbound.create({
      data: {
        idempotencyKey: `msg:${reply.id}`,
        kind: "dm",
        body: "half",
        sourceMessageId: reply.id,
      },
    });

    await recall("om_busy");

    expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "cancelled",
    );
    expect(cancel).toHaveBeenCalled();
    expect(
      (await prisma.messagingOutbound.findUniqueOrThrow({ where: { id: queued.id } })).status,
    ).toBe("recalled");
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("ignores a message it never received", async () => {
    const { ids, recall } = await setup();
    await recall("om_unknown");
    expect(
      await prisma.event.count({
        where: { threadId: ids.threadId, type: "thread.message.deleted" },
      }),
    ).toBe(0);
  });
});
