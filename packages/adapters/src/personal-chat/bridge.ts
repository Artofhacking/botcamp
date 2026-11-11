import { randomBytes } from "node:crypto";
import type { AdapterContext, MessagingInboundMessage, SecretStore } from "@botcamp/adapter-kit";
import { linkableChatApps } from "@botcamp/core";
import type { PrismaClient } from "@botcamp/db";
import { runAsSystem } from "@botcamp/db";
import { getLogger } from "@botcamp/logging";
import type { FeishuClient, FeishuInbound, FeishuLogin, FeishuSession } from "./feishu.js";
import { createFeishuClient, FEISHU_CHAT_PROVIDER, FeishuProtocolError } from "./feishu.js";
import type { IlinkClient, IlinkSession } from "./ilink.js";
import { createIlinkClient, IlinkPauseError, personalChatOrigin } from "./ilink.js";

export const PERSONAL_CHAT_PROVIDER = "weixin";
const LOGIN_TTL_MS = 3 * 60_000;
const LEASE_MS = 90_000;
const PAUSE_MS = 60 * 60_000;
const WATCH_INTERVAL_MS = 10_000;

export interface PersonalChatActor {
  userId: string;
  spaceId: string;
}

export interface PersonalChatLink {
  provider: string;
  address: string;
  botId: string;
}

export type PersonalChatPoll =
  | { status: "wait" | "scanned" | "need_pin" | "expired" | "already_linked" }
  | { status: "linked"; link: PersonalChatLink };

export class PersonalChatError extends Error {
  constructor(
    readonly code: "not_primary" | "already_linked" | "not_found" | "expired" | "unavailable",
  ) {
    super(code);
    this.name = "PersonalChatError";
  }
}

export function personalChatThreadId(
  accountId: string,
  peerId: string,
  provider: string = PERSONAL_CHAT_PROVIDER,
): string {
  return `${provider}:${accountId}:${peerId}`;
}

export function parsePersonalChatThreadId(
  threadId: string,
): { provider: string; accountId: string; peerId: string } | null {
  const cut = threadId.indexOf(":");
  if (cut <= 0) return null;
  const provider = threadId.slice(0, cut);
  if (!linkableChatApps().includes(provider)) return null;
  const rest = threadId.slice(cut + 1);
  const peerCut = rest.indexOf(":");
  if (peerCut <= 0 || peerCut === rest.length - 1) return null;
  return { provider, accountId: rest.slice(0, peerCut), peerId: rest.slice(peerCut + 1) };
}

/**
 * One person's linked chat app. The API process long-polls; a lease keeps a
 * second process from reading the same account at the same time.
 */
export class PersonalChatBridge {
  private readonly owner = randomBytes(8).toString("hex");
  private readonly client: IlinkClient;
  private readonly feishu: FeishuClient;
  private sink: ((event: MessagingInboundMessage) => Promise<void>) | undefined;
  private abort: AbortController | undefined;
  private readonly loops = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    client?: IlinkClient,
    feishu?: FeishuClient,
  ) {
    this.client = client ?? createIlinkClient();
    this.feishu = feishu ?? createFeishuClient();
  }

  onInbound(sink: (event: MessagingInboundMessage) => Promise<void>) {
    this.sink = sink;
  }

  async list(actor: PersonalChatActor, botId: string): Promise<PersonalChatLink[]> {
    const link = await this.prisma.chatToolLink.findFirst({
      where: { botId, userId: actor.userId, spaceId: actor.spaceId },
    });
    return link ? [publicLink(link)] : [];
  }

  async start(
    actor: PersonalChatActor,
    botId: string,
    provider: string,
  ): Promise<{
    loginId: string;
    image: string;
    expiresAt: string;
  }> {
    const bot = await this.prisma.bot.findFirst({
      where: { id: botId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true, isPrimary: true },
    });
    if (!bot?.isPrimary) throw new PersonalChatError("not_primary");
    if (await this.alreadyLinked(actor, botId)) throw new PersonalChatError("already_linked");
    if (!linkableChatApps().includes(provider)) throw new PersonalChatError("unavailable");
    await this.clearLogins(actor, botId);
    if (provider === FEISHU_CHAT_PROVIDER) return this.startFeishu(actor, botId);
    const qr = await this.client.fetchQr();
    if (qr.image.length > 1_000_000) throw new PersonalChatError("unavailable");
    const id = randomBytes(16).toString("hex");
    const sealed = await this.secrets.put(
      JSON.stringify({ qrcode: qr.qrcode, baseUrl: qr.baseUrl }),
      secretContext(id, actor),
      { recordId: id },
    );
    const expiresAt = new Date(Date.now() + LOGIN_TTL_MS);
    try {
      await this.prisma.chatToolLogin.create({
        data: {
          id,
          provider: PERSONAL_CHAT_PROVIDER,
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          ciphertext: sealed.ciphertext,
          image: qr.image,
          expiresAt,
        },
      });
    } catch (error) {
      await this.secrets.delete(sealed.ciphertext, id).catch(() => undefined);
      throw error;
    }
    return { loginId: id, image: qr.image, expiresAt: expiresAt.toISOString() };
  }

  async poll(actor: PersonalChatActor, loginId: string, pin?: string): Promise<PersonalChatPoll> {
    if (pin && !/^\d{1,8}$/.test(pin)) throw new PersonalChatError("unavailable");
    const login = await this.prisma.chatToolLogin.findFirst({
      where: { id: loginId, userId: actor.userId, spaceId: actor.spaceId },
    });
    if (!login) throw new PersonalChatError("not_found");
    if (login.expiresAt.getTime() <= Date.now()) {
      await this.removeLogin(login);
      return { status: "expired" };
    }
    if (login.provider === FEISHU_CHAT_PROVIDER) return this.pollFeishu(actor, login);
    const saved = readLogin(await this.secrets.load(login.ciphertext, login.id));
    let baseUrl = saved.baseUrl;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.client.pollQr({
        qrcode: saved.qrcode,
        baseUrl,
        ...(pin && attempt === 0 ? { pin } : {}),
      });
      if (state.kind === "redirect") {
        baseUrl = state.baseUrl;
        await this.secrets.put(
          JSON.stringify({ qrcode: saved.qrcode, baseUrl }),
          secretContext(login.id, actor),
          { recordId: login.id },
        );
        continue;
      }
      if (state.kind === "wait") return { status: "wait" };
      if (state.kind === "scanned") return { status: "scanned" };
      if (state.kind === "need_pin") return { status: "need_pin" };
      if (state.kind === "expired") {
        await this.removeLogin(login);
        return { status: "expired" };
      }
      if (state.kind === "already") return { status: "already_linked" };
      return this.finish(actor, login, state.session);
    }
    return { status: "wait" };
  }

  async unlink(actor: PersonalChatActor, botId: string): Promise<void> {
    const link = await this.prisma.chatToolLink.findFirst({
      where: { botId, userId: actor.userId, spaceId: actor.spaceId },
    });
    if (!link) throw new PersonalChatError("not_found");
    try {
      const session = readSession(await this.secrets.load(link.ciphertext, link.id));
      await this.client.notify(session, false);
    } catch {
      // Stopping is best-effort. The link still has to come off.
    }
    await this.prisma.messagingIdentity.deleteMany({
      where: { botId, provider: link.provider, userId: actor.userId },
    });
    await this.prisma.chatToolLink.delete({ where: { id: link.id } });
    await this.secrets.delete(link.ciphertext, link.id).catch(() => undefined);
    this.loops.get(link.id)?.abort();
    this.loops.delete(link.id);
  }

  async send(threadId: string, body: string): Promise<{ handle: string }> {
    const parsed = parsePersonalChatThreadId(threadId);
    if (!parsed) throw new Error("Unknown chat thread");
    const link = await this.prisma.chatToolLink.findFirst({
      where: { provider: parsed.provider, accountId: parsed.accountId },
    });
    if (!link) throw new Error("Chat app is not linked");
    if (parsed.provider === FEISHU_CHAT_PROVIDER) {
      const session = readFeishuSession(await this.secrets.load(link.ciphertext, link.id));
      const handle = await this.feishu.sendText(session, parsed.peerId, body);
      return { handle };
    }
    const session = readSession(await this.secrets.load(link.ciphertext, link.id));
    const handle = await this.client.sendText(
      session,
      parsed.peerId,
      body,
      session.contextTokens[parsed.peerId],
    );
    return { handle };
  }

  async openDirect(provider: string, address: string, context: AdapterContext): Promise<string> {
    const link = await this.prisma.chatToolLink.findFirst({
      where: {
        provider,
        address,
        userId: context.userId,
        spaceId: context.spaceId,
      },
    });
    if (!link) throw new Error("Chat app is not linked");
    return personalChatThreadId(link.accountId, address, provider);
  }

  startWatching() {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.supervise(abort.signal);
  }

  async stopWatching() {
    this.abort?.abort();
    this.abort = undefined;
    for (const loop of this.loops.values()) loop.abort();
    this.loops.clear();
    await runAsSystem("release chat app polls", () =>
      this.prisma.chatToolLink.updateMany({
        where: { pollOwner: this.owner },
        data: { pollOwner: null, pollUntil: null },
      }),
    ).catch((error: unknown) => {
      getLogger().warn("chat app poll release failed", { error });
    });
  }

  private async supervise(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const rows = await runAsSystem("list linked chat apps", () =>
          this.prisma.chatToolLink.findMany({ select: { id: true } }),
        );
        const live = new Set(rows.map((row) => row.id));
        for (const id of live) this.watch(id, signal);
        for (const [id, loop] of this.loops) {
          if (live.has(id)) continue;
          loop.abort();
          this.loops.delete(id);
        }
      } catch (error) {
        getLogger().error("chat app watch failed", error);
      }
      await sleep(WATCH_INTERVAL_MS, signal);
    }
  }

  private watch(id: string, parent: AbortSignal) {
    if (this.loops.has(id)) return;
    const loop = new AbortController();
    this.loops.set(id, loop);
    const signal = AbortSignal.any([parent, loop.signal]);
    void this.accountLoop(id, signal);
  }

  private async accountLoop(id: string, signal: AbortSignal) {
    let pauseMs = 1_000;
    while (!signal.aborted) {
      try {
        const row = await runAsSystem("read a linked chat app", () =>
          this.prisma.chatToolLink.findUnique({ where: { id } }),
        );
        if (!row) return;
        if (row.pausedUntil && row.pausedUntil.getTime() > Date.now()) {
          await sleep(Math.min(row.pausedUntil.getTime() - Date.now(), 60_000), signal);
          continue;
        }
        if (row.provider === FEISHU_CHAT_PROVIDER) {
          await this.watchFeishu(id, signal);
          continue;
        }
        const claimed = await this.claim(id);
        if (!claimed) {
          await sleep(5_000, signal);
          continue;
        }
        const session = readSession(await this.secrets.load(claimed.ciphertext, claimed.id));
        const update = await this.client.getUpdates(session, claimed.syncCursor, signal);
        for (const message of update.messages) {
          await this.sink?.({
            type: "message",
            provider: PERSONAL_CHAT_PROVIDER,
            handle: message.handle,
            threadId: personalChatThreadId(claimed.accountId, message.from),
            isDirect: true,
            from: message.from,
            fromLabel: null,
            channelName: null,
            participants: [],
            content: message.text,
            mediaUrl: null,
          });
          if (message.contextToken)
            await this.remember(claimed, message.from, message.contextToken);
        }
        await runAsSystem("save a chat app cursor", () =>
          this.prisma.chatToolLink.updateMany({
            where: { id, pollOwner: this.owner },
            data: { syncCursor: update.cursor },
          }),
        );
        pauseMs = 1_000;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof IlinkPauseError) {
          await runAsSystem("pause a chat app", () =>
            this.prisma.chatToolLink.updateMany({
              where: { id, pollOwner: this.owner },
              data: {
                pausedUntil: new Date(Date.now() + PAUSE_MS),
                pollOwner: null,
                pollUntil: null,
              },
            }),
          ).catch(() => undefined);
        } else {
          getLogger().error("chat app receive failed", error);
        }
        await sleep(pauseMs, signal);
        pauseMs = Math.min(pauseMs * 2, 30_000);
      }
    }
  }

  private async claim(id: string) {
    const until = new Date(Date.now() + LEASE_MS);
    const claimed = await runAsSystem("claim a chat app poll", () =>
      this.prisma.chatToolLink.updateMany({
        where: {
          id,
          OR: [{ pollOwner: this.owner }, { pollUntil: null }, { pollUntil: { lt: new Date() } }],
        },
        data: { pollOwner: this.owner, pollUntil: until },
      }),
    );
    if (claimed.count !== 1) return null;
    return runAsSystem("read a claimed chat app", () =>
      this.prisma.chatToolLink.findUnique({ where: { id } }),
    );
  }

  private async remember(
    link: { id: string; ciphertext: string; spaceId: string; userId: string },
    peerId: string,
    contextToken: string,
  ) {
    const session = readSession(await this.secrets.load(link.ciphertext, link.id));
    if (session.contextTokens[peerId] === contextToken) return;
    session.contextTokens[peerId] = contextToken;
    const sealed = await this.secrets.put(JSON.stringify(session), secretContext(link.id, link), {
      recordId: link.id,
    });
    const saved = await runAsSystem("save a chat app reply token", () =>
      this.prisma.chatToolLink.updateMany({
        where: { id: link.id, ciphertext: link.ciphertext, pollOwner: this.owner },
        data: { ciphertext: sealed.ciphertext },
      }),
    );
    if (saved.count !== 1)
      await this.secrets.delete(sealed.ciphertext, link.id).catch(() => undefined);
  }

  private async finish(
    actor: PersonalChatActor,
    login: { id: string; botId: string; ciphertext: string },
    session: IlinkSession,
  ): Promise<PersonalChatPoll> {
    const id = randomBytes(16).toString("hex");
    const sealed = await this.secrets.put(JSON.stringify(session), secretContext(id, actor), {
      recordId: id,
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        if (await this.alreadyLinked(actor, login.botId, tx)) {
          throw new PersonalChatError("already_linked");
        }
        await tx.chatToolLink.create({
          data: {
            id,
            provider: PERSONAL_CHAT_PROVIDER,
            accountId: session.accountId,
            address: session.userId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: login.botId,
            ciphertext: sealed.ciphertext,
          },
        });
        await tx.messagingIdentity.create({
          data: {
            provider: PERSONAL_CHAT_PROVIDER,
            address: session.userId,
            dmThreadId: personalChatThreadId(session.accountId, session.userId),
            userId: actor.userId,
            spaceId: actor.spaceId,
            botId: login.botId,
            verifiedAt: new Date(),
          },
        });
        await tx.chatToolLogin.delete({ where: { id: login.id } });
      });
    } catch (error) {
      await this.secrets.delete(sealed.ciphertext, id).catch(() => undefined);
      if (isUnique(error)) throw new PersonalChatError("already_linked");
      throw error;
    }
    await this.secrets.delete(login.ciphertext, login.id).catch(() => undefined);
    void this.client.notify(session, true).catch(() => undefined);
    if (this.abort) this.watch(id, this.abort.signal);
    return {
      status: "linked",
      link: { provider: PERSONAL_CHAT_PROVIDER, address: session.userId, botId: login.botId },
    };
  }

  private async startFeishu(actor: PersonalChatActor, botId: string) {
    let started: { login: FeishuLogin; image: string; expiresInMs: number };
    try {
      started = await this.feishu.begin();
    } catch (error) {
      if (error instanceof FeishuProtocolError) throw new PersonalChatError("unavailable");
      throw error;
    }
    if (started.image.length > 1_000_000) throw new PersonalChatError("unavailable");
    const id = randomBytes(16).toString("hex");
    const sealed = await this.secrets.put(JSON.stringify(started.login), secretContext(id, actor), {
      recordId: id,
    });
    const expiresAt = new Date(Date.now() + started.expiresInMs);
    try {
      await this.prisma.chatToolLogin.create({
        data: {
          id,
          provider: FEISHU_CHAT_PROVIDER,
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          ciphertext: sealed.ciphertext,
          image: started.image,
          expiresAt,
        },
      });
    } catch (error) {
      await this.secrets.delete(sealed.ciphertext, id).catch(() => undefined);
      throw error;
    }
    return { loginId: id, image: started.image, expiresAt: expiresAt.toISOString() };
  }

  private async pollFeishu(
    actor: PersonalChatActor,
    login: { id: string; botId: string; ciphertext: string },
  ): Promise<PersonalChatPoll> {
    const saved = readFeishuLogin(await this.secrets.load(login.ciphertext, login.id));
    let state: Awaited<ReturnType<FeishuClient["poll"]>>;
    try {
      state = await this.feishu.poll(saved);
    } catch (error) {
      if (error instanceof FeishuProtocolError) throw new PersonalChatError("unavailable");
      throw error;
    }
    if (state.kind === "expired") {
      await this.removeLogin(login);
      return { status: "expired" };
    }
    if (state.kind === "wait") {
      if (JSON.stringify(state.login) !== JSON.stringify(saved)) {
        await this.replaceLoginSecret(actor, login, JSON.stringify(state.login));
      }
      return { status: "wait" };
    }
    return this.finishFeishu(actor, login, state.session);
  }

  private async finishFeishu(
    actor: PersonalChatActor,
    login: { id: string; botId: string; ciphertext: string },
    session: FeishuSession,
  ): Promise<PersonalChatPoll> {
    const id = randomBytes(16).toString("hex");
    const address = session.userOpenId || session.appId;
    const sealed = await this.secrets.put(JSON.stringify(session), secretContext(id, actor), {
      recordId: id,
    });
    try {
      await this.prisma.$transaction(async (tx) => {
        if (await this.alreadyLinked(actor, login.botId, tx)) {
          throw new PersonalChatError("already_linked");
        }
        await tx.chatToolLink.create({
          data: {
            id,
            provider: FEISHU_CHAT_PROVIDER,
            accountId: session.appId,
            address,
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: login.botId,
            ciphertext: sealed.ciphertext,
          },
        });
        if (session.userOpenId) {
          await tx.messagingIdentity.create({
            data: {
              provider: FEISHU_CHAT_PROVIDER,
              address: session.userOpenId,
              dmThreadId: personalChatThreadId(
                session.appId,
                session.userOpenId,
                FEISHU_CHAT_PROVIDER,
              ),
              userId: actor.userId,
              spaceId: actor.spaceId,
              botId: login.botId,
              verifiedAt: new Date(),
            },
          });
        }
        await tx.chatToolLogin.delete({ where: { id: login.id } });
      });
    } catch (error) {
      await this.secrets.delete(sealed.ciphertext, id).catch(() => undefined);
      if (error instanceof PersonalChatError) throw error;
      if (isUnique(error)) throw new PersonalChatError("already_linked");
      throw error;
    }
    await this.secrets.delete(login.ciphertext, login.id).catch(() => undefined);
    if (this.abort) this.watch(id, this.abort.signal);
    return {
      status: "linked",
      link: { provider: FEISHU_CHAT_PROVIDER, address, botId: login.botId },
    };
  }

  private async watchFeishu(id: string, signal: AbortSignal) {
    const claimed = await this.claim(id);
    if (!claimed) {
      await sleep(5_000, signal);
      return;
    }
    const session = readFeishuSession(await this.secrets.load(claimed.ciphertext, claimed.id));
    const listenAbort = new AbortController();
    const stop = () => listenAbort.abort();
    signal.addEventListener("abort", stop);
    let live = true;
    const renew = setInterval(() => {
      if (!live) return;
      void this.claim(id)
        .then((held) => {
          if (live && !held) listenAbort.abort();
        })
        .catch((error: unknown) => {
          getLogger().error("chat app receive failed", error);
        });
    }, 30_000);
    try {
      await this.feishu.listen(session, listenAbort.signal, (message) =>
        this.acceptFeishu(claimed, session, message),
      );
    } finally {
      live = false;
      clearInterval(renew);
      signal.removeEventListener("abort", stop);
      await this.release(id);
    }
  }

  private async acceptFeishu(
    link: {
      id: string;
      ciphertext: string;
      spaceId: string;
      userId: string;
      botId: string;
      accountId: string;
    },
    session: FeishuSession,
    message: FeishuInbound,
  ) {
    try {
      if (session.botOpenId && message.from === session.botOpenId) return;
      if (!session.userOpenId) {
        const bound = await this.bindFeishuUser(link, session, message.from);
        if (!bound) return;
      } else if (message.from !== session.userOpenId) {
        return;
      }
      await this.sink?.({
        type: "message",
        provider: FEISHU_CHAT_PROVIDER,
        handle: message.handle,
        threadId: personalChatThreadId(link.accountId, message.from, FEISHU_CHAT_PROVIDER),
        isDirect: true,
        from: message.from,
        fromLabel: null,
        channelName: null,
        participants: [],
        content: message.text,
        mediaUrl: null,
      });
    } catch (error) {
      getLogger().error("chat app receive failed", error);
    }
  }

  private async bindFeishuUser(
    link: {
      id: string;
      ciphertext: string;
      spaceId: string;
      userId: string;
      botId: string;
      accountId: string;
    },
    session: FeishuSession,
    from: string,
  ): Promise<boolean> {
    const previous = session.userOpenId;
    session.userOpenId = from;
    const sealed = await this.secrets.put(JSON.stringify(session), secretContext(link.id, link), {
      recordId: link.id,
    });
    try {
      await runAsSystem("bind a feishu chat", () =>
        this.prisma.$transaction(async (tx) => {
          const saved = await tx.chatToolLink.updateMany({
            where: { id: link.id, ciphertext: link.ciphertext },
            data: { ciphertext: sealed.ciphertext, address: from },
          });
          if (saved.count !== 1) throw new Error("lost");
          await tx.messagingIdentity.create({
            data: {
              provider: FEISHU_CHAT_PROVIDER,
              address: from,
              dmThreadId: personalChatThreadId(link.accountId, from, FEISHU_CHAT_PROVIDER),
              userId: link.userId,
              spaceId: link.spaceId,
              botId: link.botId,
              verifiedAt: new Date(),
            },
          });
        }),
      );
    } catch (error) {
      session.userOpenId = previous;
      await this.secrets.delete(sealed.ciphertext, link.id).catch(() => undefined);
      if (isUnique(error) || (error instanceof Error && error.message === "lost")) return false;
      throw error;
    }
    link.ciphertext = sealed.ciphertext;
    return true;
  }

  private async replaceLoginSecret(
    actor: PersonalChatActor,
    login: { id: string; ciphertext: string },
    plaintext: string,
  ) {
    const sealed = await this.secrets.put(plaintext, secretContext(login.id, actor), {
      recordId: login.id,
    });
    if (sealed.ciphertext === login.ciphertext) return;
    const saved = await this.prisma.chatToolLogin.updateMany({
      where: { id: login.id, ciphertext: login.ciphertext },
      data: { ciphertext: sealed.ciphertext },
    });
    if (saved.count === 1) {
      login.ciphertext = sealed.ciphertext;
      return;
    }
    await this.secrets.delete(sealed.ciphertext, login.id).catch(() => undefined);
  }

  private async release(id: string) {
    await runAsSystem("release a chat app poll", () =>
      this.prisma.chatToolLink.updateMany({
        where: { id, pollOwner: this.owner },
        data: { pollOwner: null, pollUntil: null },
      }),
    ).catch((error: unknown) => {
      getLogger().warn("chat app poll release failed", { error });
    });
  }

  /** One linked chat app for this user's bot. Any chat identity already occupies that slot. */
  private async alreadyLinked(
    actor: PersonalChatActor,
    botId: string,
    db: Pick<PrismaClient, "chatToolLink" | "messagingIdentity"> = this.prisma,
  ) {
    const [link, identity] = await Promise.all([
      db.chatToolLink.findFirst({
        where: { botId, userId: actor.userId },
        select: { id: true },
      }),
      db.messagingIdentity.findFirst({
        where: { botId, userId: actor.userId },
        select: { id: true },
      }),
    ]);
    return Boolean(link || identity);
  }

  private async clearLogins(actor: PersonalChatActor, botId: string) {
    const rows = await this.prisma.chatToolLogin.findMany({
      where: { botId, userId: actor.userId, spaceId: actor.spaceId },
    });
    for (const row of rows) await this.removeLogin(row);
  }

  private async removeLogin(login: { id: string; ciphertext: string }) {
    await this.prisma.chatToolLogin.deleteMany({ where: { id: login.id } });
    await this.secrets.delete(login.ciphertext, login.id).catch(() => undefined);
  }
}

function publicLink(link: { provider: string; address: string; botId: string }): PersonalChatLink {
  return { provider: link.provider, address: link.address, botId: link.botId };
}

function secretContext(id: string, actor: { spaceId: string; userId: string }): AdapterContext {
  return {
    operationId: id,
    traceId: id,
    spaceId: actor.spaceId,
    userId: actor.userId,
    signal: AbortSignal.timeout(10_000),
  };
}

function readLogin(raw: string): { qrcode: string; baseUrl: string } {
  const value = JSON.parse(raw) as { qrcode?: string; baseUrl?: string };
  const baseUrl = personalChatOrigin(value.baseUrl ?? "");
  if (!value.qrcode || !baseUrl) throw new PersonalChatError("unavailable");
  return { qrcode: value.qrcode, baseUrl };
}

function readFeishuLogin(raw: string): FeishuLogin {
  const value = JSON.parse(raw) as Partial<FeishuLogin>;
  if (
    value.kind !== "feishu" ||
    !value.deviceCode ||
    (value.domain !== "https://accounts.feishu.cn" &&
      value.domain !== "https://accounts.larksuite.com")
  ) {
    throw new PersonalChatError("unavailable");
  }
  return {
    kind: "feishu",
    deviceCode: value.deviceCode,
    domain: value.domain,
    intervalMs: value.intervalMs && value.intervalMs > 0 ? value.intervalMs : 5_000,
    notBefore: value.notBefore ?? 0,
    ...(value.switched ? { switched: true } : {}),
  };
}

function readFeishuSession(raw: string): FeishuSession {
  const value = JSON.parse(raw) as Partial<FeishuSession>;
  if (
    value.kind !== "feishu" ||
    !value.appId ||
    !value.appSecret ||
    (value.openBase !== "https://open.feishu.cn" && value.openBase !== "https://open.larksuite.com")
  ) {
    throw new PersonalChatError("unavailable");
  }
  return {
    kind: "feishu",
    appId: value.appId,
    appSecret: value.appSecret,
    openBase: value.openBase,
    botOpenId: value.botOpenId ?? "",
    userOpenId: value.userOpenId ?? "",
  };
}

function readSession(raw: string): IlinkSession {
  const value = JSON.parse(raw) as Partial<IlinkSession>;
  const baseUrl = personalChatOrigin(value.baseUrl ?? "");
  if (!value.token || !value.accountId || !value.userId || !baseUrl) {
    throw new PersonalChatError("unavailable");
  }
  return {
    token: value.token,
    accountId: value.accountId,
    userId: value.userId,
    baseUrl,
    contextTokens: value.contextTokens ?? {},
  };
}

function isUnique(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
