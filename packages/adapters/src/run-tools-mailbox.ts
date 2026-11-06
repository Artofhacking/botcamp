import { mailboxCanSend } from "./mailbox-app.js";
import type { SavedMailbox } from "./mailbox-connection.js";
import { loadSavedMailbox } from "./mailbox-connection.js";
import {
  listMailboxMessages,
  MailboxLoginError,
  readMailboxMessage,
  searchMailboxMessages,
} from "./qq-imap.js";
import { sendMailboxMessage } from "./qq-smtp.js";
import type { RunContext } from "./run-context.js";
import type { ToolHandlers } from "./run-tool-gate.js";

const NOT_CONNECTED = "No mailbox is connected. Use connect_app with QQ邮箱 and wait for the user.";
const CANNOT_SEND = "This mailbox connection cannot send. Connect QQ邮箱 again and choose sending.";

async function savedMailbox(ctx: RunContext): Promise<SavedMailbox | { error: string }> {
  const saved = await loadSavedMailbox(ctx.deps.prisma, ctx.deps.secretStore, {
    userId: ctx.run.userId,
    spaceId: ctx.run.spaceId,
  });
  if (!saved) return { error: NOT_CONNECTED };
  ctx.secrets.push(saved.authCode);
  return saved;
}

function limitOf(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function mailboxError(error: unknown): { error: string } {
  if (error instanceof MailboxLoginError) return { error: error.message };
  return { error: "Could not reach the mailbox" };
}

export const mailboxTools: ToolHandlers = {
  async mailbox_list(ctx, call) {
    const saved = await savedMailbox(ctx);
    if ("error" in saved) return call.finish(saved);
    try {
      const messages = await listMailboxMessages(saved, limitOf(call.args.limit));
      return call.finish({ address: saved.address, messages });
    } catch (error) {
      return call.finish(mailboxError(error));
    }
  },
  async mailbox_get(ctx, call) {
    const saved = await savedMailbox(ctx);
    if ("error" in saved) return call.finish(saved);
    const uid = typeof call.args.uid === "string" ? call.args.uid : "";
    try {
      const message = await readMailboxMessage(saved, uid);
      if (!message) return call.finish({ error: "No message with that id." });
      return call.finish({ address: saved.address, message });
    } catch (error) {
      return call.finish(mailboxError(error));
    }
  },
  async mailbox_search(ctx, call) {
    const saved = await savedMailbox(ctx);
    if ("error" in saved) return call.finish(saved);
    const query = typeof call.args.query === "string" ? call.args.query : "";
    if (!query.trim()) return call.finish({ error: "Provide text to search for." });
    try {
      const messages = await searchMailboxMessages(saved, query, limitOf(call.args.limit));
      return call.finish({ address: saved.address, messages });
    } catch (error) {
      return call.finish(mailboxError(error));
    }
  },
  async mailbox_send(ctx, call) {
    const saved = await savedMailbox(ctx);
    if ("error" in saved) return call.finish(saved);
    if (!mailboxCanSend(saved.scope)) return call.finish({ error: CANNOT_SEND });
    const to = typeof call.args.to === "string" ? call.args.to.trim() : "";
    const subject = typeof call.args.subject === "string" ? call.args.subject : "";
    const text = typeof call.args.text === "string" ? call.args.text : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
      return call.finish({ error: "Provide a recipient." });
    if (!subject.trim() || subject.length > 200) {
      return call.finish({ error: "Provide a subject of at most 200 characters." });
    }
    if (!text.trim() || text.length > 20_000) {
      return call.finish({ error: "Provide a message of at most 20000 characters." });
    }
    try {
      await sendMailboxMessage({
        address: saved.address,
        authCode: saved.authCode,
        to,
        subject,
        text,
      });
      return call.finish({ sent: true, to });
    } catch (error) {
      return call.finish(mailboxError(error));
    }
  },
};
