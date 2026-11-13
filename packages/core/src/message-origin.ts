import type { AppMessageOrigin } from "@botcamp/contracts";
import { AppMessageOriginSchema } from "@botcamp/contracts";
import { messagingProviderName } from "./messaging-providers.js";

/**
 * The page calls this with the desktop bridge's platform, or with nothing in a browser.
 * `darwin`, `win32`, and `linux` are the desktop apps. The Android shell reports itself
 * separately. A phone browser does not, and stays the web app.
 */
export function appMessageOrigin(
  desktopPlatform: string | null | undefined,
  shellPlatform?: string | null,
): AppMessageOrigin {
  if (desktopPlatform === "darwin") return "mac";
  if (desktopPlatform === "win32") return "windows";
  if (desktopPlatform === "linux") return "linux";
  if (shellPlatform?.trim().toLowerCase() === "android") return "android";
  return "web";
}

const CHAT_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Stored origin for a messaging provider. Undefined when the id is not safe to keep. */
export function chatMessageOrigin(provider: string): string | undefined {
  if (!CHAT_PROVIDER_ID.test(provider)) return undefined;
  return `chat:${provider}`;
}

/** Accept only origins this process knows how to describe. Anything else is dropped. */
export function normalizeMessageOrigin(origin: string | null | undefined): string | undefined {
  if (!origin) return undefined;
  if (AppMessageOriginSchema.safeParse(origin).success) return origin;
  if (!origin.startsWith("chat:")) return undefined;
  return chatMessageOrigin(origin.slice("chat:".length));
}

const APP_ORIGIN_LINE: Record<AppMessageOrigin, string> = {
  web: "This message arrived from the web app.",
  mac: "This message arrived from the Mac app.",
  windows: "This message arrived from the Windows app.",
  linux: "This message arrived from the Linux app.",
  android: "This message arrived from the Android app.",
};

/**
 * A linked chat app can only carry plain text. The person cannot tap a choice, take over
 * the computer, or finish any other action that exists only in the app.
 */
export const PLAIN_TEXT_CHANNEL_LIMIT =
  "This person can only read and send plain text on this channel, so answer in an ordinary message. Choice cards, computer takeover, and other actions that need the app are not available.";

/** True when the stored origin is a chat channel (`chat:<provider>`), never an app. */
export function isPlainTextChannelOrigin(origin: string | null | undefined): boolean {
  const stored = normalizeMessageOrigin(origin);
  return Boolean(stored?.startsWith("chat:"));
}

/**
 * One sentence for the model. It stays off the system prompt: the next message can arrive
 * from a different place, and that change must not rewrite the cacheable prefix.
 * Names come from the provider list. An id that is not in the list is shown as itself.
 * A chat channel adds the plain-text limit, because that person cannot use the app.
 */
export function formatMessageOriginInstruction(
  origin: string | null | undefined,
): string | undefined {
  const stored = normalizeMessageOrigin(origin);
  if (!stored) return undefined;
  const app = AppMessageOriginSchema.safeParse(stored);
  if (app.success) return APP_ORIGIN_LINE[app.data];
  const provider = stored.slice("chat:".length);
  return `This message arrived from ${messagingProviderName(provider)}. ${PLAIN_TEXT_CHANNEL_LIMIT}`;
}

/** Keep the sender's words, then say where they arrived from when that is known. */
export function appendMessageOrigin(text: string, origin: string | null | undefined): string {
  const line = formatMessageOriginInstruction(origin);
  if (!line) return text;
  return text ? `${text}\n\n${line}` : line;
}
