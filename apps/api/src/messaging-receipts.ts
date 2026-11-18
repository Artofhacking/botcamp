import { randomUUID } from "node:crypto";
import type { AdapterContext, MessagingSurface } from "@botcamp/adapter-kit";
import { providerOfThreadId } from "@botcamp/adapters";
import { getLogger } from "@botcamp/logging";

// A reaction stays on the message, so it only goes on a late one: a fast reply
// is its own acknowledgement.
const REACTION_DELAY_MS = 60_000;

const RECEIPT_TIMEOUT_MS = 2000;
/**
 * A typing bubble fades on its own, so it is shown again while the reply is
 * pending. Chat services and runs both have their own timeouts; this one only
 * keeps an abandoned run from typing forever.
 */
const TYPING_KEEPALIVE_MS = 5_000;
const TYPING_MAX_MS = 15 * 60_000;

export interface MessagingReceipts {
  acknowledge(threadId: string, handle: string, handled: () => Promise<boolean>): void;
  stop(): void;
}

interface TypingSession {
  threadId: string;
  handle: string;
  /** One check per message whose reply the bubble is waiting for. */
  handled: Array<() => Promise<boolean>>;
  startedAt: number;
}

export function createMessagingReceipts(
  messaging: Pick<MessagingSurface, "platforms" | "acknowledge" | "stopTyping">,
): MessagingReceipts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const typing = new Map<string, TypingSession>();
  let stopped = false;

  const receiptContext = (operationId: string): AdapterContext => ({
    operationId,
    traceId: operationId,
    spaceId: "",
    userId: "",
    signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
  });

  const send = async (threadId: string, handle: string): Promise<void> => {
    const operationId = `messaging.acknowledge:${randomUUID()}`;
    await messaging.acknowledge(threadId, handle, receiptContext(operationId));
  };

  const clearTyping = async (threadId: string): Promise<void> => {
    if (!messaging.stopTyping) return;
    const operationId = `messaging.typing.stop:${randomUUID()}`;
    await messaging.stopTyping(threadId, receiptContext(operationId));
  };

  const logFailure = (error: unknown) => getLogger().error("messaging receipt error", error);

  const keepTyping = async (session: TypingSession): Promise<void> => {
    if (stopped || typing.get(session.threadId) !== session) return;
    const replied = (
      await Promise.all(session.handled.map((check) => check().catch(() => false)))
    ).every(Boolean);
    if (stopped || typing.get(session.threadId) !== session) return;
    if (replied || Date.now() - session.startedAt >= TYPING_MAX_MS) {
      typing.delete(session.threadId);
      await clearTyping(session.threadId).catch(logFailure);
      return;
    }
    // A refresh that fails is not worth an error line every few seconds; the
    // chat can still receive the reply.
    await send(session.threadId, session.handle).catch((error: unknown) => {
      getLogger().debug("messaging typing refresh failed", { error });
    });
    scheduleTyping(session);
  };

  const scheduleTyping = (session: TypingSession): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void keepTyping(session);
    }, TYPING_KEEPALIVE_MS);
    timer.unref?.();
    timers.add(timer);
  };

  const startTyping = (threadId: string, handle: string, handled: () => Promise<boolean>): void => {
    const live = typing.get(threadId);
    if (live) {
      live.handled.push(handled);
      return;
    }
    const session: TypingSession = { threadId, handle, handled: [handled], startedAt: Date.now() };
    typing.set(threadId, session);
    send(threadId, handle).catch(logFailure);
    scheduleTyping(session);
  };

  return {
    acknowledge(threadId, handle, handled) {
      if (stopped) return;
      const provider = providerOfThreadId(threadId);
      const receipt = messaging.platforms().find((platform) => platform.provider === provider)
        ?.capabilities.receipt;
      if (!receipt) return;
      if (receipt === "typing") {
        startTyping(threadId, handle, handled);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        (async () => {
          if ((await handled()) || stopped) return;
          await send(threadId, handle);
        })().catch(logFailure);
      }, REACTION_DELAY_MS);
      timer.unref?.();
      timers.add(timer);
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      typing.clear();
    },
  };
}
