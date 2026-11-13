import { ORPCError } from "@orpc/server";
import type { PrismaClient } from "@botcamp/db";

/**
 * One bot per account is the primary one, and only it manages the others. The rule is stored
 * as `isPrimary`; this helper answers the two questions the routes need.
 */
export async function isPrimaryBot(
  prisma: PrismaClient,
  userId: string,
  botId: string,
): Promise<boolean> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { userId: true, isPrimary: true } });
  return Boolean(bot && bot.userId === userId && bot.isPrimary);
}

/** The bot a management request comes from must be the account's primary bot. */
export async function requirePrimaryBot(
  prisma: PrismaClient,
  userId: string,
  actingBotId: string | null | undefined,
): Promise<void> {
  if (!actingBotId) return;
  if (await isPrimaryBot(prisma, userId, actingBotId)) return;
  throw new ORPCError("FORBIDDEN", {
    message: "只有主 bot 可以管理其他 bot",
  });
}
