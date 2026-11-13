import type { MessageBlock } from "@botcamp/contracts";
import { botMessageContext, sharedGroupBotName } from "@botcamp/core";
import type { PrismaClient } from "@botcamp/db";

/** What the model reads for the one human of a group thread: never their real name. */
export const USER_SPEAKER = "User";
/** Label for a bot whose record is gone, so its messages are still not mistaken for the receiver's own. */
export const UNKNOWN_BOT_SPEAKER = "another bot";

/**
 * A bot's name as it appears in a label: one line, no brackets (so a name cannot close or fake
 * a `[Name]:` label), and never the human's label (a bot called "user" reads as "User (bot)").
 */
export function speakerName(name: string): string {
  const clean = name
    .replace(/[[\]]/g, (bracket) => (bracket === "[" ? "(" : ")"))
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return UNKNOWN_BOT_SPEAKER;
  return clean.toLowerCase() === USER_SPEAKER.toLowerCase() ? `${USER_SPEAKER} (bot)` : clean;
}

/**
 * A line that starts like a `[Name]:` label, with the brackets swapped for parentheses, so text
 * inside a message cannot pose as another speaker's turn once turns are joined.
 */
export function neutralizeSpeakerLabels(text: string): string {
  return text.replace(/^([ \t]*)\[([^\]\n]*)\]:/gm, "$1($2):");
}

/**
 * Who is speaking in a group thread, from the receiving bot's side. Direct chats have no
 * speakers: the bot and the user are the only two parties there, so roles say it all.
 */
export interface ThreadSpeakers {
  /** The receiving bot; its own messages stay unlabelled assistant turns. */
  botId: string;
  /** Current names of the other bots, archived ones included. A renamed bot has one name everywhere. */
  names: Map<string, string>;
  /** Account names for shared-group messages that name who sent them. */
  people?: Map<string, string>;
}

type SpeakerRow = {
  role: string;
  botId?: string | null;
  blocks?: unknown;
  senderUserId?: string | null;
};

type SpeakerClient = Pick<PrismaClient, "bot"> & Partial<Pick<PrismaClient, "chatGroup" | "user">>;

/** Names for bot ids in the space, deleted bots simply absent. No archived filter on purpose. */
export async function loadBotNames(
  prisma: Pick<PrismaClient, "bot">,
  spaceId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const bots = await prisma.bot.findMany({
    where: { id: { in: ids }, spaceId },
    select: { id: true, name: true },
  });
  return new Map(bots.map((bot) => [bot.id, speakerName(bot.name)]));
}

/** Null for a direct chat, which needs neither labels nor a lookup. */
function personLabel(name: string): string {
  const clean = name
    .replace(/[[\]]/g, (bracket) => (bracket === "[" ? "(" : ")"))
    .replace(/\s+/g, " ")
    .trim();
  return clean || USER_SPEAKER;
}

async function loadSharedSpeakers(
  prisma: SpeakerClient & { user: NonNullable<SpeakerClient["user"]> },
  run: { bot: { id: string } },
  rows: SpeakerRow[],
  others: string[],
): Promise<ThreadSpeakers> {
  const bots =
    others.length === 0
      ? []
      : await prisma.bot.findMany({
          where: { id: { in: others } },
          select: { id: true, name: true, userId: true },
        });
  const senderIds = rows.flatMap((row) =>
    row.role === "user" && row.senderUserId ? [row.senderUserId] : [],
  );
  const userIds = [...new Set([...bots.map((bot) => bot.userId), ...senderIds])];
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        });
  const userNames = new Map(users.map((user) => [user.id, user.name]));
  return {
    botId: run.bot.id,
    names: new Map(
      bots.map((bot) => [
        bot.id,
        speakerName(sharedGroupBotName(userNames.get(bot.userId) ?? "User", bot.name)),
      ]),
    ),
    people: new Map(
      senderIds.flatMap((userId) => {
        const name = userNames.get(userId);
        return name ? [[userId, personLabel(name)] as const] : [];
      }),
    ),
  };
}

export async function loadThreadSpeakers(
  prisma: SpeakerClient,
  thread: { groupId?: string | null },
  run: { spaceId: string; bot: { id: string } },
  rows: SpeakerRow[],
): Promise<ThreadSpeakers | null> {
  if (!thread.groupId) return null;
  const others = [
    ...new Set(
      rows.flatMap((row) =>
        row.role === "bot" && row.botId && row.botId !== run.bot.id ? [row.botId] : [],
      ),
    ),
  ];
  if (prisma.chatGroup && prisma.user) {
    const group = await prisma.chatGroup.findUnique({
      where: { id: thread.groupId },
      select: { shared: true },
    });
    if (group?.shared)
      return loadSharedSpeakers({ ...prisma, user: prisma.user }, run, rows, others);
  }
  return {
    botId: run.bot.id,
    names: await loadBotNames(prisma, run.spaceId, others),
  };
}

function isRelay(blocks: unknown): boolean {
  return Array.isArray(blocks) && Boolean(botMessageContext(blocks as MessageBlock[]));
}

/**
 * The label a message carries in the receiving bot's history, or undefined for an unlabelled one:
 * the bot's own replies, system rows, and a relayed peer message, which already says `[from X]`.
 * Another bot is named even after it was archived; once its record is gone it is "another bot".
 * Two bots with the same name share a label; the roster the model reads lists them apart.
 */
export function historySpeaker(
  speakers: ThreadSpeakers | null | undefined,
  row: SpeakerRow,
): string | undefined {
  if (!speakers) return undefined;
  if (row.role === "user") {
    if (isRelay(row.blocks)) return undefined;
    if (row.senderUserId && speakers.people) {
      const name = speakers.people.get(row.senderUserId);
      if (name) return name;
    }
    return USER_SPEAKER;
  }
  if (row.role !== "bot" || !row.botId || row.botId === speakers.botId) return undefined;
  return speakers.names.get(row.botId) ?? UNKNOWN_BOT_SPEAKER;
}
