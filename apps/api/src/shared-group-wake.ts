import type { JobPublisher } from "@botcamp/adapter-kit";
import { runContinueJob } from "@botcamp/adapter-kit";
import { displayName, sharedGroupBotName, sharedGroupWakePrompt } from "@botcamp/core";
import type { PrismaClient, ThreadEvents } from "@botcamp/db";
import { Prisma, runAsSystem } from "@botcamp/db";

const TRANSCRIPT_MESSAGES = 20;
const TRANSCRIPT_CHARS = 4_000;

export type SharedGroupWakeBot = {
  botId: string;
  userId: string;
  spaceId: string;
  name: string;
};

export type SharedGroupWakeInput = {
  groupId: string;
  groupName: string;
  groupThreadId: string;
  sourceMessageId: string;
  senderUserId: string;
  senderText: string;
  bots: SharedGroupWakeBot[];
};

/** Same-space bots run on the group thread. A bot from another space is woken on its own thread. */
export function partitionSharedGroupBots(
  shared: boolean,
  groupSpaceId: string,
  members: Array<{ botId: string; userId?: string; spaceId?: string; name: string }>,
  targetBotIds: string[],
): { inThreadIds: string[]; foreign: SharedGroupWakeBot[] } {
  if (!shared) return { inThreadIds: targetBotIds, foreign: [] };
  const byId = new Map(members.map((member) => [member.botId, member]));
  const inThreadIds: string[] = [];
  const foreign: SharedGroupWakeBot[] = [];
  for (const botId of targetBotIds) {
    const member = byId.get(botId);
    if (member?.spaceId && member.spaceId !== groupSpaceId && member.userId) {
      foreign.push({
        botId,
        userId: member.userId,
        spaceId: member.spaceId,
        name: member.name,
      });
    } else {
      inThreadIds.push(botId);
    }
  }
  return { inThreadIds, foreign };
}

/** Keep the newest lines, including a single over-long line trimmed from the end. */
export function capSharedGroupTranscript(lines: readonly string[], maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line) continue;
    const next = used + line.length + (kept.length ? 1 : 0);
    if (kept.length > 0 && next > maxChars) break;
    if (kept.length === 0 && line.length > maxChars) {
      const sliced = line.slice(line.length - maxChars);
      const first = sliced.charCodeAt(0);
      kept.push(first >= 0xdc00 && first <= 0xdfff ? sliced.slice(1) : sliced);
      break;
    }
    kept.push(line);
    used = next;
  }
  return kept.reverse().join("\n");
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const row = block as { kind?: unknown; text?: unknown };
      return row.kind === "text" && typeof row.text === "string" ? [row.text.trim()] : [];
    })
    .filter(Boolean)
    .join("\n");
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Start a foreign bot on its own private thread, then let finalize copy the text reply back.
 * The caller already committed the group message. A failure here must not undo that send.
 */
export async function wakeSharedGroupBots(
  deps: {
    prisma: PrismaClient;
    jobs: JobPublisher;
    events: Pick<ThreadEvents, "sendUserMessage">;
  },
  input: SharedGroupWakeInput,
): Promise<void> {
  if (input.bots.length === 0) return;
  const runs = await runAsSystem("wake shared group bot", async () => {
    const prior = await deps.prisma.message.findMany({
      where: { threadId: input.groupThreadId, id: { not: input.sourceMessageId } },
      orderBy: { seq: "desc" },
      take: TRANSCRIPT_MESSAGES,
      select: { role: true, blocks: true, botId: true, senderUserId: true },
    });
    const botIds = [
      ...new Set(prior.flatMap((message) => (message.botId ? [message.botId] : []))),
    ];
    const senderIds = [
      ...new Set([
        input.senderUserId,
        ...prior.flatMap((message) => (message.senderUserId ? [message.senderUserId] : [])),
      ]),
    ];
    const [botRows, userRows] = await Promise.all([
      botIds.length
        ? deps.prisma.bot.findMany({
            where: { id: { in: botIds } },
            select: { id: true, name: true, userId: true },
          })
        : [],
      senderIds.length
        ? deps.prisma.user.findMany({
            where: { id: { in: senderIds } },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const ownerIds = [...new Set(botRows.map((bot) => bot.userId))].filter(
      (id) => !senderIds.includes(id),
    );
    const owners = ownerIds.length
      ? await deps.prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(
      [...userRows, ...owners].map((user) => [user.id, displayName(user.name, "User")]),
    );
    const botNames = new Map(
      botRows.map((bot) => [
        bot.id,
        sharedGroupBotName(names.get(bot.userId) ?? "User", displayName(bot.name, "Bot")),
      ]),
    );
    const lines = prior
      .slice()
      .reverse()
      .flatMap((message) => {
        const text = textOf(message.blocks);
        if (!text) return [];
        const speaker =
          message.role === "bot"
            ? (botNames.get(message.botId ?? "") ?? "Bot")
            : message.senderUserId
              ? (names.get(message.senderUserId) ?? "User")
              : "User";
        return [`${speaker}: ${text}`];
      });
    const senderName = names.get(input.senderUserId) ?? "User";
    const senderText = capSharedGroupTranscript([input.senderText.trim()], TRANSCRIPT_CHARS);
    const promptFor = (display: string) =>
      sharedGroupWakePrompt({
        groupName: input.groupName,
        displayName: display,
        transcript: capSharedGroupTranscript(lines, TRANSCRIPT_CHARS),
        senderLine: `${senderName}: ${senderText}`,
      });
    const started: string[] = [];
    for (const target of input.bots) {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: target.botId, archivedAt: null },
        select: { id: true, userId: true, spaceId: true, thread: { select: { id: true } } },
      });
      if (!bot?.thread) continue;
      const prompt = promptFor(target.name);
      const sent = await deps.events.sendUserMessage({
        spaceId: bot.spaceId,
        threadId: bot.thread.id,
        botId: bot.id,
        userId: bot.userId,
        blocks: [{ kind: "text", text: prompt }],
        prompt,
        trigger: "user",
        origin: "web",
        allowParallelRun: true,
        clientNonce: `shared-group:${input.sourceMessageId}:${bot.id}`,
      });
      if (!sent.runId) continue;
      try {
        await deps.prisma.sharedGroupWake.create({
          data: {
            groupId: input.groupId,
            groupThreadId: input.groupThreadId,
            sourceMessageId: input.sourceMessageId,
            botId: bot.id,
            runId: sent.runId,
          },
        });
      } catch (error) {
        if (isUniqueConflict(error)) continue;
        throw error;
      }
      started.push(sent.runId);
    }
    return started;
  });
  for (const runId of runs) {
    await deps.jobs.enqueue(runContinueJob(runId));
  }
}
