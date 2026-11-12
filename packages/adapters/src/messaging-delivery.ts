import type {
  AdapterContext,
  ArtifactStore,
  JobPublisher,
  MessagingOutboundAttachment,
  MessagingOutboundStatus,
  MessagingSurface,
} from "@botcamp/adapter-kit";
import { messagingDeliverJob, runContinueJob } from "@botcamp/adapter-kit";
import type { MessageBlock } from "@botcamp/contracts";
import {
  botMessageHopExhausted,
  chatMessageOrigin,
  nextBotMessageHop,
  pageLinksAsTitles,
} from "@botcamp/core";
import type { PrismaClient, ThreadEvents } from "@botcamp/db";
import {
  appendEventInTransaction,
  CrossSpaceCommunicationBlockedError,
  createThreadMessageInTransaction,
  crossSpaceCommunicationAllowed,
  messagingIdentityForBot,
  runAsSystem,
} from "@botcamp/db";
import { getLogger } from "@botcamp/logging";
import { MessagingSendError } from "./chat-sdk-surface.js";
import { splitOutboundBody } from "./messaging-platforms.js";

/**
 * Margin under vendor consecutive-outbound caps (sendblue enforces one hard):
 * past this many DMs without a reply from the owner, mirror rows stay pending
 * until the next inbound resets the counter.
 */
export const MESSAGING_DM_OUTBOUND_CAP = 140;

/** Provider-send attempts before a mirrored row is declared lost. */
export const MESSAGING_OUTBOUND_MAX_ATTEMPTS = 5;

/** The outbox columns a drain reads and updates. */
type MessagingOutboundRow = {
  id: string;
  idempotencyKey: string;
  kind: string;
  identityId: string | null;
  threadId: string | null;
  body: string;
  attempts: number | null;
  nextAttemptAt: Date | null;
  sourceMessageId: string | null;
  createdAt: Date;
};

export interface MessagingDeliveryDeps {
  prisma: PrismaClient;
  messaging: MessagingSurface;
  events: Pick<ThreadEvents, "sendUserMessage" | "notify">;
  jobs: Pick<JobPublisher, "enqueue">;
  artifacts: Pick<ArtifactStore, "get">;
}

type IdentityRow = {
  id: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  outboundSinceInbound: number;
};

/**
 * Automatic mirror for the channel a message arrived on, plus any channels the
 * sync_channels tool named. Other linked channels stay quiet. Agent-to-agent
 * fan-out stays internal and never transits the messaging provider. Also drains
 * outbox rows the channels slice enqueued.
 */
export async function deliverMessagingOutbound(
  deps: MessagingDeliveryDeps,
  input: { runId?: string },
  context: AdapterContext,
): Promise<void> {
  if (input.runId) {
    await mirrorMessagingOutbound(deps, input.runId);
  }
  await drain(deps, context);
}

export async function mirrorMessagingOutbound(
  deps: MessagingDeliveryDeps,
  runId: string,
): Promise<void> {
  await mirrorRun(deps, runId);
  await deps.prisma.run.updateMany({
    where: { id: runId, trigger: "messaging" },
    data: { messagingMirroredAt: new Date() },
  });
}

const CHAT_CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Providers a successful sync_channels call asked to include, in call order. */
async function syncChannelProviders(deps: MessagingDeliveryDeps, runId: string): Promise<string[]> {
  const effects = await deps.prisma.externalEffect.findMany({
    where: { runId, kind: "sync_channels" },
    orderBy: { createdAt: "asc" },
    select: { result: true },
  });
  const providers: string[] = [];
  for (const effect of effects) {
    const result = effect.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const record = result as { ok?: unknown; channels?: unknown };
    if (record.ok !== true || !Array.isArray(record.channels)) continue;
    for (const channel of record.channels) {
      if (typeof channel !== "string" || !CHAT_CHANNEL_ID.test(channel)) continue;
      if (!providers.includes(channel)) providers.push(channel);
    }
  }
  return providers;
}

async function mirrorRun(deps: MessagingDeliveryDeps, runId: string): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { sourceMessage: true },
  });
  if (!run) return;

  const sourceBlocks = (run.sourceMessage?.blocks ?? []) as MessageBlock[];
  const channelBlock =
    run.trigger === "messaging"
      ? sourceBlocks.find(
          (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
            block.kind === "channel_message",
        )
      : undefined;
  if (channelBlock) await mirrorChannelRun(deps, run, channelBlock);

  // The arrival channel always gets the reply. sync_channels adds only the
  // channels it named. A personal chat with no recorded origin, and a delegated
  // bot_message with no request, still use the oldest identity.
  const requested = await syncChannelProviders(deps, run.id);
  const sourceProvider = channelBlock
    ? undefined
    : providerFromChatOrigin(run.sourceMessage?.origin);
  const providers: string[] = [];
  if (sourceProvider) providers.push(sourceProvider);
  for (const provider of requested) {
    if (!providers.includes(provider)) providers.push(provider);
  }
  if (
    providers.length === 0 &&
    !channelBlock &&
    (run.trigger === "messaging" || run.trigger === "bot_message")
  ) {
    const oldest = await messagingIdentityForBot(deps.prisma, run.botId);
    if (oldest) providers.push(oldest.provider);
  }
  if (providers.length === 0) return;

  // bot_message runs can carry the bot's user-facing reply after a delegate wake.
  // extractText keeps only text and page titles, so inter-bot chatter blocks never leak out.
  const messages = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  const linkedPages = linkedPageIds(messages);
  const createdAt = Date.now();
  const rows: Array<{
    idempotencyKey: string;
    kind: string;
    identityId: string;
    body: string;
    sourceMessageId: string;
    createdAt: Date;
  }> = [];
  for (const [providerIndex, provider] of providers.entries()) {
    const identity = await messagingIdentityForBot(deps.prisma, run.botId, provider);
    if (!identity) continue;
    const sendsFiles = deps.messaging
      .platforms()
      .some((platform) => platform.provider === identity.provider && platform.capabilities.files);
    // The first destination keeps the original keys so a retry does not send it twice.
    const via = providerIndex === 0 ? "" : `:via:${provider}`;
    for (const message of messages) {
      const body = extractText(message.blocks, linkedPages);
      const parts = body ? splitOutboundBody(identity.provider, body) : [];
      for (const [index, part] of parts.entries()) {
        rows.push({
          idempotencyKey:
            index === 0 ? `msg:${message.id}${via}` : `msg:${message.id}${via}:${index + 1}`,
          kind: "dm",
          identityId: identity.id,
          body: part,
          sourceMessageId: message.id,
          createdAt: new Date(createdAt + rows.length),
        });
      }
      if (!sendsFiles) continue;
      for (const artifactId of extractArtifactIds(message.blocks)) {
        rows.push({
          idempotencyKey: `msg:${message.id}${via}:file:${artifactId}`,
          kind: "dm",
          identityId: identity.id,
          body: "",
          sourceMessageId: message.id,
          createdAt: new Date(createdAt + rows.length),
        });
      }
    }
  }
  if (rows.length === 0) return;
  // Atomic dedupe: a concurrent messaging.deliver for the same run loses on
  // the idempotencyKey unique key instead of throwing P2002.
  await deps.prisma.messagingOutbound.createMany({ data: rows, skipDuplicates: true });
}

/**
 * Channel runs post to the group with an attribution prefix, then fan the
 * post out internally to peer approved bots: context only by default, a
 * waking run on @-mention, bounded by the shared bot-message hop budget.
 */
async function mirrorChannelRun(
  deps: MessagingDeliveryDeps,
  run: { id: string; botId: string },
  channelBlock: Extract<MessageBlock, { kind: "channel_message" }>,
): Promise<void> {
  const identity = await messagingIdentityForBot(deps.prisma, run.botId, channelBlock.provider);
  if (!identity) return;
  const channel = await deps.prisma.messagingChannel.findUnique({
    where: { id: channelBlock.channelId },
  });
  if (!channel) return;
  const owner = await deps.prisma.user.findUnique({
    where: { id: identity.userId },
    select: { name: true },
  });
  const firstName = owner?.name.trim().split(/\s+/)[0] || "Owner";
  const fromLabel = `${firstName}'s agent`;

  const replies = await deps.prisma.message.findMany({
    select: { id: true, blocks: true },
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
  });
  // Ask answers are entered privately in the app. Check the same snapshot as
  // the replies so a resumed run cannot publish an answer-influenced response.
  if (
    replies.some((message) =>
      (message.blocks as MessageBlock[]).some(
        (block) => block.kind === "ask" && block.status === "answered",
      ),
    )
  )
    return;
  const linkedPages = linkedPageIds(replies);
  const messages = replies
    .map((message) => ({ message, text: extractText(message.blocks, linkedPages) }))
    .filter((entry) => entry.text);
  if (messages.length === 0) return;

  await deps.prisma.messagingOutbound.createMany({
    data: messages.map(({ message, text }) => ({
      idempotencyKey: `msg:${message.id}`,
      kind: "group",
      threadId: channel.threadId,
      body: `${fromLabel}: ${text}`,
      sourceMessageId: message.id,
    })),
    skipDuplicates: true,
  });

  const hop = nextBotMessageHop(channelBlock.hop);
  const peers = await deps.prisma.messagingChannelMember.findMany({
    where: {
      channelId: channel.id,
      status: "approved",
      identityId: { not: null },
      NOT: { identityId: identity.id },
    },
  });
  // Peer bots belong to other members, usually in other Spaces.
  await runAsSystem("fan a group post out to peer bots in other Spaces", () =>
    fanOutToPeers(deps, { identity, channel, channelBlock, fromLabel, hop, peers, messages }),
  );
}

async function fanOutToPeers(
  deps: MessagingDeliveryDeps,
  {
    identity,
    channel,
    channelBlock,
    fromLabel,
    hop,
    peers,
    messages,
  }: {
    identity: { provider: string; address: string; botId: string };
    channel: { id: string; name: string | null };
    channelBlock: Extract<MessageBlock, { kind: "channel_message" }>;
    fromLabel: string;
    hop: number;
    peers: Array<{ identityId: string | null }>;
    messages: Array<{ message: { id: string }; text: string }>;
  },
): Promise<void> {
  for (const { message, text } of messages) {
    for (const peer of peers) {
      const peerIdentity = await deps.prisma.messagingIdentity.findUnique({
        where: { id: peer.identityId! },
      });
      if (!peerIdentity) continue;
      if (!(await crossSpaceCommunicationAllowed(deps.prisma, identity.botId, peerIdentity.botId)))
        continue;
      const peerThread = await deps.prisma.thread.findFirst({
        where: { botId: peerIdentity.botId },
      });
      if (!peerThread) continue;
      const peerBot = await deps.prisma.bot.findUnique({
        where: { id: peerIdentity.botId },
        select: { name: true },
      });
      const block: MessageBlock = {
        kind: "channel_message",
        provider: identity.provider,
        ...(channelBlock.transport ? { transport: channelBlock.transport } : {}),
        channelId: channel.id,
        fromAddress: identity.address,
        fromLabel,
        text,
        hop,
      };
      const clientNonce = `messaging-peer:${message.id}:${peerIdentity.botId}`;
      const mentioned = peerBot?.name
        ? new RegExp(`@${escapeRegExp(peerBot.name)}\\b`, "i").test(text)
        : false;
      if (mentioned && !botMessageHopExhausted(hop)) {
        const sent = await deps.events
          .sendUserMessage({
            spaceId: peerIdentity.spaceId,
            threadId: peerThread.id,
            botId: peerIdentity.botId,
            userId: peerIdentity.userId,
            blocks: [block],
            prompt: `[Group "${channel.name ?? "group"}" — ${fromLabel}]: ${text}`,
            trigger: "messaging",
            clientNonce,
            origin: chatMessageOrigin(identity.provider),
            crossSpaceSenderBotId: identity.botId,
          })
          .catch((error: unknown) => {
            if (error instanceof CrossSpaceCommunicationBlockedError) return null;
            throw error;
          });
        if (sent?.runId) {
          await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
            getLogger().error("messaging peer wake enqueue error", error);
          });
        }
        continue;
      }
      // Context only: the peer sees the post in history without a wake.
      const existing = await deps.prisma.message.findUnique({
        where: { threadId_clientNonce: { threadId: peerThread.id, clientNonce } },
      });
      if (existing) continue;
      const event = await deps.prisma
        .$transaction(async (tx) => {
          const created = await createThreadMessageInTransaction(tx, {
            threadId: peerThread.id,
            role: "user",
            blocks: [block],
            clientNonce,
          });
          if (!(await crossSpaceCommunicationAllowed(tx, identity.botId, peerIdentity.botId)))
            throw new CrossSpaceCommunicationBlockedError();
          return appendEventInTransaction(tx, {
            spaceId: peerIdentity.spaceId,
            threadId: peerThread.id,
            botId: peerIdentity.botId,
            type: "thread.message.created",
            payload: { messageId: created.id, role: "user", blocks: [block] },
          });
        })
        .catch((error: unknown) => {
          if (error instanceof CrossSpaceCommunicationBlockedError) return null;
          throw error;
        });
      if (event) await deps.events.notify(peerThread.id, event.seq).catch(() => undefined);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `connect:{requesterBotId}:{targetBotId}` — agent-connection approval DMs. */
function connectInvitePair(
  idempotencyKey: string,
): { requesterBotId: string; targetBotId: string } | null {
  const match = /^connect:([^:]+):([^:]+)$/.exec(idempotencyKey);
  if (!match) return null;
  return { requesterBotId: match[1]!, targetBotId: match[2]! };
}

/**
 * Deliver a connect invite while holding the connection row lock.
 * Revoke's status update blocks behind this lock, so it cannot commit
 * (and delete the claim) between the pending check and the send.
 * Only used for rare approval DMs, not for ordinary mirrored traffic.
 *
 * At-most-once: any failure after the provider call (or an ambiguous
 * transport error) keeps the outer claim as `sent` so drain does not
 * restore pending and duplicate the YES/NO DM. A lost invite is fine;
 * reconnect starts a fresh cycle.
 */
async function sendConnectInvite(
  deps: MessagingDeliveryDeps,
  row: { id: string; body: string },
  threadId: string,
  pair: { requesterBotId: string; targetBotId: string },
  context: AdapterContext,
): Promise<"delivered" | "skipped" | "held"> {
  try {
    return await deps.prisma.$transaction(
      async (tx) => {
        const communicationAllowed = await crossSpaceCommunicationAllowed(
          tx,
          pair.requesterBotId,
          pair.targetBotId,
        );
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM agent_connections
          WHERE "requesterBotId" = ${pair.requesterBotId}
            AND "targetBotId" = ${pair.targetBotId}
          FOR UPDATE
        `;
        if (locked[0]?.status !== "pending" || !communicationAllowed) {
          await tx.messagingOutbound.updateMany({
            where: { id: row.id },
            data: { status: "failed" },
          });
          return "skipped";
        }
        const outbound = await tx.messagingOutbound.findUnique({
          where: { id: row.id },
          select: { id: true },
        });
        if (!outbound) return "skipped";
        try {
          const sent = await deps.messaging.sendToThread({ threadId, body: row.body }, context);
          await tx.messagingOutbound.updateMany({
            where: { id: row.id },
            data: { providerHandle: sent.handle },
          });
          return "delivered";
        } catch {
          // Provider error or lost response is ambiguous without an
          // idempotency key. Do not ask drain to retry.
          return "held";
        }
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch {
    // Lock/timeout after a possible accept: keep the outer claim as sent.
    return "held";
  }
}

async function drain(deps: MessagingDeliveryDeps, context: AdapterContext): Promise<void> {
  const pending = await deps.prisma.messagingOutbound.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  // Each conversation is its own lane, so a slow provider holds back only
  // the replies queued behind it.
  const heads = new Map<string, MessagingOutboundRow>();
  for (const row of pending) {
    const key = row.identityId ?? row.threadId ?? row.id;
    if (!heads.has(key)) heads.set(key, row);
  }
  const lanes = await Promise.allSettled(
    [...heads.values()].map((head) => deliverLane(deps, context, head)),
  );
  const failed = lanes.find((lane) => lane.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

type Conversation = { identityId: string } | { identityId: null; threadId: string };

function conversationOf(row: MessagingOutboundRow): Conversation | null {
  if (row.identityId) return { identityId: row.identityId };
  if (row.threadId) return { identityId: null, threadId: row.threadId };
  return null;
}

/**
 * Sends one conversation's rows in order, reading each next row after the
 * previous send so a reply queued meanwhile is not left behind. Stops at the
 * first row that has to wait, or that another drain already owns.
 */
async function deliverLane(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  head: MessagingOutboundRow,
): Promise<void> {
  const conversation = conversationOf(head);
  let row: MessagingOutboundRow | null = head;
  while (row) {
    const now = Date.now();
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now) return;
    if (conversation && (await hasUndeliveredEarlierRow(deps, conversation, row.createdAt, now)))
      return;
    // Claim before sending: concurrent drains and crash retries must never
    // deliver the same message twice.
    const claim = await deps.prisma.messagingOutbound.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "sent", nextAttemptAt: null },
    });
    if (claim.count === 0) return;
    if (!(await deliverRow(deps, context, row))) return;
    row = conversation
      ? await deps.prisma.messagingOutbound.findFirst({
          where: { status: "pending", ...conversation },
          orderBy: { createdAt: "asc" },
        })
      : null;
  }
}

/** Sends one claimed row. Returns false when later rows to the same place must wait. */
async function deliverRow(
  deps: MessagingDeliveryDeps,
  context: AdapterContext,
  row: MessagingOutboundRow,
): Promise<boolean> {
  let attachmentName: string | null = null;
  let accepted = false;
  try {
    if (row.kind === "group" || row.kind === "intro") {
      if (!row.threadId) {
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        return true;
      }
      const sent = await deps.messaging.sendToThread(
        { threadId: row.threadId, body: row.body },
        context,
      );
      accepted = true;
      await deps.prisma.messagingOutbound.update({
        where: { id: row.id },
        data: { providerHandle: sent.handle },
      });
      return true;
    }
    const identity = row.identityId
      ? await deps.prisma.messagingIdentity.findUnique({ where: { id: row.identityId } })
      : null;
    if (!identity) {
      await deps.prisma.messagingOutbound.update({
        where: { id: row.id },
        data: { status: "failed" },
      });
      return true;
    }
    // Sendblue's consecutive-outbound vendor cap; other providers have no
    // equivalent limit, so do not hold Slack/WhatsApp/Telegram DMs.
    if (
      identity.provider === "sendblue" &&
      identity.outboundSinceInbound >= MESSAGING_DM_OUTBOUND_CAP
    ) {
      // Cap holds are not failures: release the claim back to pending.
      await deps.prisma.messagingOutbound.update({
        where: { id: row.id },
        data: { status: "pending" },
      });
      return false;
    }
    const threadId = await resolveDirectThread(deps, identity, context);
    const invitePair = connectInvitePair(row.idempotencyKey);
    if (invitePair) {
      const result = await sendConnectInvite(
        deps,
        { id: row.id, body: row.body },
        threadId,
        invitePair,
        context,
      );
      if (result === "delivered") {
        accepted = true;
        await deps.prisma.messagingIdentity.update({
          where: { id: identity.id },
          data: { outboundSinceInbound: { increment: 1 } },
        });
      }
      return true;
    }
    let attachment: MessagingOutboundAttachment | undefined;
    const artifactId = fileArtifactId(row.idempotencyKey);
    if (artifactId) {
      // Scoped to the identity's Space: the drain runs across every Space.
      const artifact = await deps.prisma.artifact.findFirst({
        where: { id: artifactId, spaceId: identity.spaceId },
        select: { name: true, mimeType: true, storageKey: true, userId: true },
      });
      if (!artifact) {
        // Deleted since the reply was mirrored, or not in this Space.
        await deps.prisma.messagingOutbound.update({
          where: { id: row.id },
          data: { status: "failed" },
        });
        return true;
      }
      attachmentName = artifact.name;
      const data = await deps.artifacts.get(artifact.storageKey, {
        ...context,
        spaceId: identity.spaceId,
        userId: artifact.userId,
      });
      attachment = { name: artifact.name, mimeType: artifact.mimeType, data };
    }
    const sent = await deps.messaging.sendToThread(
      { threadId, body: row.body, ...(attachment ? { attachment } : {}) },
      context,
    );
    accepted = true;
    await deps.prisma.messagingOutbound.updateMany({
      where: { id: row.id },
      data: { providerHandle: sent.handle },
    });
    await deps.prisma.messagingIdentity.update({
      where: { id: identity.id },
      data: { outboundSinceInbound: { increment: 1 } },
    });
    return true;
  } catch (error) {
    if (accepted) {
      // Keep the sent claim even if saving the handle or counter fails.
      getLogger().error("messaging outbound bookkeeping error", error);
      return true;
    }
    // Transient provider errors go back to pending with a backed-off
    // retry (no sooner than the provider's retry-after); a permanent error
    // or an exhausted budget is terminal.
    const failure = error instanceof MessagingSendError ? error : null;
    const attempts = (row.attempts ?? 0) + 1;
    const exhausted = failure?.permanent || attempts >= MESSAGING_OUTBOUND_MAX_ATTEMPTS;
    const delayMs = Math.max(messagingOutboundRetryDelayMs(attempts), failure?.retryAfterMs ?? 0);
    const retryAt = exhausted ? null : new Date(Date.now() + delayMs);
    const outcome = {
      where: { id: row.id },
      data: {
        attempts,
        status: exhausted ? "failed" : "pending",
        nextAttemptAt: retryAt,
      },
    };
    if (exhausted && attachmentName) {
      // The reply's text went out on its own rows; say the file did not
      // follow instead of dropping it silently. Saved with the failure so
      // one cannot land without the other, keyed so it is queued once, and
      // given the file's place so later replies wait behind it.
      const name = attachmentName;
      await deps.prisma.$transaction(async (tx) => {
        await tx.messagingOutbound.updateMany(outcome);
        await tx.messagingOutbound.createMany({
          data: [
            {
              idempotencyKey: `${row.idempotencyKey}:notice`,
              kind: row.kind,
              identityId: row.identityId,
              threadId: row.threadId,
              body: `Could not send "${name}".`,
              sourceMessageId: row.sourceMessageId,
              createdAt: row.createdAt,
            },
          ],
          skipDuplicates: true,
        });
      });
      await deps.jobs.enqueue(messagingDeliverJob());
      return false;
    }
    await deps.prisma.messagingOutbound.updateMany(outcome);
    if (!exhausted && retryAt) {
      // Propagate an enqueue failure: the messaging.deliver job then fails
      // and the queue's own retry re-runs the drain. Swallowing it would
      // strand the row in pending — no reconciler reclaims outbox rows.
      // Re-entry is safe: the row is pending again and nextAttemptAt keeps
      // other drains from racing the backoff window.
      await deps.jobs.enqueue(messagingDeliverJob(undefined, retryAt));
    }
    return false;
  }
}

/** A claimed row still without a handle after this long is treated as abandoned. */
const MESSAGING_ROW_IN_FLIGHT_MS = 2 * 60_000;

/** True while an earlier row to the conversation is still pending or in flight. */
async function hasUndeliveredEarlierRow(
  deps: MessagingDeliveryDeps,
  conversation: Conversation,
  createdAt: Date,
  now: number,
): Promise<boolean> {
  const earlier = await deps.prisma.messagingOutbound.findFirst({
    where: {
      ...conversation,
      createdAt: { lt: createdAt },
      OR: [
        { status: "pending" },
        {
          status: "sent",
          providerHandle: null,
          updatedAt: { gt: new Date(now - MESSAGING_ROW_IN_FLIGHT_MS) },
        },
      ],
    },
    select: { id: true },
  });
  return earlier !== null;
}

/**
 * DM rows address the identity, not a thread: the conversation id is learned
 * from inbound webhooks and cached, with a provider lookup as fallback for
 * identities that predate the cache (or the multi-platform migration).
 */
async function resolveDirectThread(
  deps: MessagingDeliveryDeps,
  identity: IdentityRow,
  context: AdapterContext,
): Promise<string> {
  if (identity.dmThreadId) return identity.dmThreadId;
  const threadId = await deps.messaging.openDirectThread(
    identity.provider,
    identity.address,
    context,
  );
  await deps.prisma.messagingIdentity.update({
    where: { id: identity.id },
    data: { dmThreadId: threadId },
  });
  return threadId;
}

function providerFromChatOrigin(origin: string | null | undefined): string | undefined {
  if (!origin?.startsWith("chat:")) return undefined;
  const provider = origin.slice("chat:".length);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider) ? provider : undefined;
}

function messagingOutboundRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 60_000);
}

/** Outbound status webhooks update outbox rows by provider handle. */
export async function applyMessagingOutboundStatus(
  prisma: PrismaClient,
  event: MessagingOutboundStatus,
): Promise<void> {
  const status = ["ERROR", "DECLINED", "FAILED"].includes(event.status)
    ? "failed"
    : ["SENT", "DELIVERED", "READ"].includes(event.status)
      ? "sent"
      : null;
  if (!status) return;
  await prisma.messagingOutbound.updateMany({
    where: { providerHandle: event.handle },
    data: { status },
  });
}

/** The artifact a reply's file row sends, from its `msg:<message>:file:<artifact>` key. */
function fileArtifactId(idempotencyKey: string): string | null {
  return (
    /^msg:[^:]+(?::via:[a-z0-9][a-z0-9_-]{0,63})?:file:([^:]+)$/.exec(idempotencyKey)?.[1] ?? null
  );
}

/** Artifacts of the message's image and file blocks, in block order. */
function extractArtifactIds(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; artifactId?: unknown } | null) =>
    (block?.kind === "image" || block?.kind === "file") && typeof block.artifactId === "string"
      ? [block.artifactId]
      : [],
  );
}

function textBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: { kind?: unknown; text?: unknown } | null) =>
    block?.kind === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** Pages the run's replies already link by name, so their cards add nothing more. */
function linkedPageIds(messages: readonly { blocks: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    for (const text of textBlocks(message.blocks)) {
      // Only links the conversion names count; one inside a code example stays as written, so a
      // page counts when fewer of its links remain after converting than were written.
      const converted = pageLinksAsTitles(text);
      const count = (source: string, link: string) => source.split(link).length - 1;
      for (const match of text.matchAll(/\]\(page:([A-Za-z0-9_-]{1,64})\)/g))
        if (count(converted, match[0]) < count(text, match[0])) ids.add(match[1]!);
    }
  return ids;
}

/**
 * The text other channels get. A page card cannot travel, so a page the reply does not name goes
 * as its title.
 */
function extractText(blocks: unknown, linkedPages: ReadonlySet<string>): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap(
      (block: { kind?: unknown; text?: unknown; pageId?: unknown; title?: unknown } | null) => {
        if (block?.kind === "text" && typeof block.text === "string")
          return [pageLinksAsTitles(block.text)];
        if (
          block?.kind === "page" &&
          typeof block.title === "string" &&
          typeof block.pageId === "string" &&
          !linkedPages.has(block.pageId)
        )
          return [block.title];
        return [];
      },
    )
    .join("\n")
    .trim();
}
