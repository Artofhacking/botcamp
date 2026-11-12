import type { PrismaClient } from "@botcamp/db";
import { messagingIdentityForBot } from "@botcamp/db";

/**
 * Executor dep answering "does this bot belong to a messaging identity?" —
 * one indexed query per run, and none when the messaging surface is absent.
 */
export function createMessagingContextLoader(prisma: PrismaClient) {
  return {
    hasIdentity: async (botId: string): Promise<boolean> =>
      Boolean(await messagingIdentityForBot(prisma, botId)),
  };
}
