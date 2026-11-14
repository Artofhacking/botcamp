import type { ThreadMessage } from "@botcamp/contracts";
import { previewMessageText as previewText } from "@botcamp/core";
import { t } from "@lingui/core/macro";

export type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

/** Identity colour for bots the roster no longer knows about. */
export const FALLBACK_BOT_COLOR = "#85858A";

/**
 * Whether a message belongs on the viewer's side of the chat. A shared group
 * stamps the sender on every person's message, so only the viewer's own
 * messages sit on the right; everyone else's are inbound. A chat with one
 * person has no sender stamp, and there every user message is the viewer's.
 */
export function isOwnUserMessage(
  message: Pick<ThreadMessage, "role" | "senderUserId">,
  viewerUserId: string | undefined,
): boolean {
  if (message.role !== "user") return false;
  return !message.senderUserId || message.senderUserId === viewerUserId;
}

export function previewMessageText(message: ThreadMessage): string {
  return previewText(message, { photo: t`Photo`, attachment: t`Attachment`, message: t`Message` });
}
