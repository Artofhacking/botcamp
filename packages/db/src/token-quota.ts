import { firstNonEmpty } from "@botcamp/core/env-name";
import { containerCostYuan, toCredits, tokenCostYuan, tokenListCostYuan } from "./credits.js";
import type { PrismaClient } from "./generated/prisma/client.js";

/** What a free account gets before an admin assigns a plan: ¥3 a week. */
export const DEFAULT_WEEKLY_TOKEN_QUOTA = 10_000_000n;

/** Weeks roll over at Monday 00:00 in this zone; China has no DST, so a fixed offset is exact. */
const QUOTA_TIME_ZONE =
  firstNonEmpty(process.env.BOTCAMP_QUOTA_TIME_ZONE, process.env.RAKAZO_QUOTA_TIME_ZONE)?.trim() ||
  "Asia/Shanghai";
const ZONE_OFFSET_MINUTES: Record<string, number> = { "Asia/Shanghai": 480, UTC: 0 };

export function quotaTimeZone(): string {
  return QUOTA_TIME_ZONE;
}

/** The instant the current quota week began. */
export function weekStart(now: Date = new Date(), timeZone: string = QUOTA_TIME_ZONE): Date {
  const offsetMs = (ZONE_OFFSET_MINUTES[timeZone] ?? 480) * 60_000;
  const local = new Date(now.getTime() + offsetMs);
  // getUTCDay: 0 is Sunday, so Monday is one back.
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const startLocalMs = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - sinceMonday,
  );
  return new Date(startLocalMs - offsetMs);
}

/**
 * The seven-day window that contains `now`, measured from the moment the account's allowance
 * started. Falls back to the calendar week when no anchor is known.
 */
export function quotaWindow(
  now: Date,
  anchor: Date | null | undefined,
  timeZone: string = QUOTA_TIME_ZONE,
): { start: Date; end: Date } {
  if (!anchor || Number.isNaN(anchor.getTime())) {
    return { start: weekStart(now, timeZone), end: weekEnd(now, timeZone) };
  }
  const length = 7 * 24 * 60 * 60 * 1000;
  const elapsed = Math.max(0, now.getTime() - anchor.getTime());
  const start = new Date(anchor.getTime() + Math.floor(elapsed / length) * length);
  return { start, end: new Date(start.getTime() + length) };
}

/** When the current week ends, for messages that tell a user when they get more. */
export function weekEnd(now: Date = new Date(), timeZone: string = QUOTA_TIME_ZONE): Date {
  return new Date(weekStart(now, timeZone).getTime() + 7 * 24 * 60 * 60 * 1000);
}

export async function weeklyTokensUsed(
  prisma: Pick<PrismaClient, "usageRecord">,
  userId: string,
  now: Date = new Date(),
): Promise<bigint> {
  const summed = await prisma.usageRecord.aggregate({
    where: { userId, createdAt: { gte: weekStart(now) } },
    _sum: { totalTokens: true },
  });
  return BigInt(summed._sum.totalTokens ?? 0);
}

/** Points spent: our cost in fen, so a model's price cannot change what a plan buys. */
export async function weeklyPointsUsed(
  prisma: Pick<PrismaClient, "usageRecord" | "containerUsage" | "user">,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const anchor = (
    await prisma.user.findUnique({ where: { id: userId }, select: { quotaAnchorAt: true } })
  )?.quotaAnchorAt;
  const window = quotaWindow(now, anchor);
  const [tokens, containers] = await Promise.all([
    prisma.usageRecord.aggregate({
      where: { userId, createdAt: { gte: window.start } },
      _sum: {
        inputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        outputTokens: true,
      },
    }),
    prisma.containerUsage.aggregate({
      where: { userId, day: { gte: new Date(window.start.toISOString().slice(0, 10)) } },
      _sum: { coreSeconds: true },
    }),
  ]);
  // Tokens count at list price; container time has no list price, so it counts at our cost.
  const yuan =
    tokenListCostYuan(tokens._sum) + containerCostYuan("big", containers._sum.coreSeconds ?? 0);
  return yuan * 100;
}

/**
 * Credits spent this week: model tokens at their cache-aware cost plus burst-container time.
 * Both are converted through yuan, so one balance covers everything a user consumes.
 */
export async function weeklyCreditsUsed(
  prisma: Pick<PrismaClient, "usageRecord" | "containerUsage">,
  userId: string,
  now: Date = new Date(),
): Promise<bigint> {
  const week = { gte: weekStart(now) };
  const [tokens, containers] = await Promise.all([
    prisma.usageRecord.aggregate({
      where: { userId, createdAt: week },
      _sum: {
        inputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        outputTokens: true,
      },
    }),
    prisma.containerUsage.aggregate({
      where: { userId, day: { gte: new Date(weekStart(now).toISOString().slice(0, 10)) } },
      _sum: { coreSeconds: true },
    }),
  ]);
  const tokenYuan = tokenCostYuan(tokens._sum);
  const containerYuan = containerCostYuan("big", containers._sum.coreSeconds ?? 0);
  return toCredits(tokenYuan + containerYuan);
}

export class WeeklyQuotaExceededError extends Error {
  readonly code = "quota/weekly";
  constructor(
    readonly used: bigint,
    readonly quota: bigint,
    readonly resetsAt: Date,
  ) {
    // Users never see the underlying points, only how much of the week is gone.
    super(`本周额度已用完（已用 100%），将在 ${resetsAt.toISOString().slice(0, 10)} 恢复。`);
    this.name = "WeeklyQuotaExceededError";
  }
}

/** Throws before a run spends credits the account does not have left this week. */
export async function assertWithinWeeklyQuota(
  prisma: Pick<PrismaClient, "user" | "usageRecord" | "containerUsage">,
  userId: string,
  now: Date = new Date(),
): Promise<{ used: bigint; quota: bigint }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { weeklyCreditQuota: true },
  });
  const quotaPoints = Number(user?.weeklyCreditQuota ?? DEFAULT_WEEKLY_TOKEN_QUOTA);
  const anchor = (
    await prisma.user.findUnique({ where: { id: userId }, select: { quotaAnchorAt: true } })
  )?.quotaAnchorAt;
  const window = quotaWindow(now, anchor);
  const usedPoints = await weeklyPointsUsed(prisma, userId, now);
  const used = BigInt(Math.round(usedPoints));
  const quota = BigInt(Math.round(quotaPoints));
  if (used >= quota) throw new WeeklyQuotaExceededError(used, quota, window.end);
  return { used, quota };
}
