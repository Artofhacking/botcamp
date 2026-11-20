import { describe, expect, it, vi } from "vitest";
import { BURST_CONTAINER_TIERS, weeklyCreditsUsed, weeklyPointsUsed } from "./token-quota.js";

const zeroTokens = {
  _sum: {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
};

function prismaWith() {
  const containerAggregate = vi.fn(async (_args: unknown) => ({ _sum: { coreSeconds: 0n } }));
  const usageAggregate = vi.fn(async (_args: unknown) => zeroTokens);
  return {
    prisma: {
      usageRecord: { aggregate: usageAggregate },
      containerUsage: { aggregate: containerAggregate },
      user: { findUnique: async () => ({ quotaAnchorAt: null, weeklyCreditQuota: 1000n }) },
    },
    containerAggregate,
  };
}

describe("weekly container usage", () => {
  it("counts only burst tiers toward the weekly points", async () => {
    const { prisma, containerAggregate } = prismaWith();
    await weeklyPointsUsed(prisma as never, "user-1");
    const call = containerAggregate.mock.calls[0]?.[0] as {
      where: { tier: { in: string[] } };
    };
    expect(call.where.tier).toEqual({ in: [...BURST_CONTAINER_TIERS] });
  });

  it("leaves always-on Docker computers out of the weekly credits", async () => {
    const { prisma, containerAggregate } = prismaWith();
    await weeklyCreditsUsed(prisma as never, "user-1");
    const call = containerAggregate.mock.calls[0]?.[0] as {
      where: { tier: { in: string[] } };
    };
    expect(call.where.tier).toEqual({ in: ["big", "desktop"] });
  });
});

describe("own-connection usage", () => {
  it("leaves usage on the user's own connection out of the weekly points", async () => {
    const usageAggregate = vi.fn(async (_args: unknown) => zeroTokens);
    const prisma = {
      usageRecord: { aggregate: usageAggregate },
      containerUsage: { aggregate: async () => ({ _sum: { coreSeconds: 0n } }) },
      user: { findUnique: async () => ({ quotaAnchorAt: null, weeklyCreditQuota: 1000n }) },
    };
    await weeklyPointsUsed(prisma as never, "user-1");
    const call = usageAggregate.mock.calls[0]?.[0] as { where: { quotaExempt: boolean } };
    expect(call.where.quotaExempt).toBe(false);
  });
});
