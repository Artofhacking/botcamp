import type { MessageBlock } from "@botcamp/contracts";
import { messagingProviderName } from "./messaging-providers.js";

const CHAT_CHANNEL_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Channel ids from a sync_channels call that this bot has actually linked.
 * Anything else is dropped. An empty request, or a request that matches nothing, is an error.
 */
export function resolveSyncChannels(
  requested: unknown,
  linked: readonly string[],
): { ok: true; channels: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(requested) ? requested : [];
  const ids: string[] = [];
  for (const item of raw) {
    const id = String(item ?? "")
      .trim()
      .toLowerCase();
    if (!CHAT_CHANNEL_ID.test(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  if (ids.length === 0) return { ok: false, error: "Name at least one linked chat channel." };
  const linkedSet = new Set(linked);
  const channels = ids.filter((id) => linkedSet.has(id));
  if (channels.length === 0) {
    return {
      ok: false,
      error: linked.length
        ? `None of those channels are linked. Linked channels: ${linked.join(", ")}.`
        : "No chat channel is linked.",
    };
  }
  return { ok: true, channels };
}

/** Instruction-stack note for a bot that has at least one linked chat channel. */
export function messagingDmSurfaceNote(syncChannels = true): string {
  return [
    "Chat channels: the owner may reach you from more than one linked chat app.",
    "A reply goes back only on the channel that message arrived from. It is not copied to the other linked channels.",
    syncChannels
      ? "When the person asks for this reply on specific other linked channels, call sync_channels with those channel ids."
      : undefined,
    "Keep replies concise. They arrive as chat messages.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Per-turn list of linked channel ids, so sync_channels is called with those ids. */
export function formatLinkedChatChannels(providers: readonly string[]): string | undefined {
  if (providers.length === 0) return undefined;
  const list = providers
    .map((provider) => `${messagingProviderName(provider)} (${provider})`)
    .join(", ");
  return `Linked chat channels: ${list}.`;
}

/** Hard privacy rules for bots posting into shared group channels. */
export function messagingChannelPrivacyBlock(): string {
  return [
    "You are posting to a group chat with multiple people through the deployment's shared messaging line.",
    "Never reveal or share the owner's personal information, memory contents, scratchpad, or 1:1 conversation contents in the group.",
    'Your posts are publicly attributed to the owner ("<name>\'s agent: …").',
    "Reply only when you add value to the group; otherwise finish silently without posting.",
  ].join("\n");
}

/** Privacy rules for a shared chat when the message is from someone other than the owner. */
export function nonOwnerChatPrivacyBlock(): string {
  return [
    "This message is from someone other than your owner, in a shared chat.",
    "Never reveal or share the owner's personal information, memory contents, scratchpad, or private conversations.",
  ].join("\n");
}

export function messagingChannelId(sourceBlocks: MessageBlock[] | undefined): string | undefined {
  return sourceBlocks?.find((block) => block.kind === "channel_message")?.channelId;
}

/** Channel runs are messaging runs whose waking message came from a channel. */
export function isMessagingChannelRun(
  trigger: string,
  sourceBlocks: MessageBlock[] | undefined,
): boolean {
  return trigger === "messaging" && Boolean(messagingChannelId(sourceBlocks));
}

/**
 * Group names and owner names are attacker-controlled text interpolated
 * into prompts and DMs; strip framing characters before they get near one.
 */
export function sanitizeMessagingLabel(value: string): string {
  return value
    .replace(/[\r\n"[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}
