import type { PrismaClient } from "@botcamp/db";
import { describe, expect, it, vi } from "vitest";
import { burstProvisionGuard, pickComputerTier, sandboxTierFor } from "./tiered-sandbox.js";

function bots(rows: {
  byId?: { computerTier: string | null; archivedAt: Date | null } | null;
  byHome?: Array<{ computerTier: string | null }>;
}) {
  return {
    bot: {
      findUnique: vi.fn(async () => rows.byId ?? null),
      findMany: vi.fn(async () => rows.byHome ?? []),
    },
  } as unknown as Pick<PrismaClient, "bot">;
}

describe("sandbox tier", () => {
  it("ranks a desktop above a burst container", () => {
    expect(pickComputerTier(["small", "big", "desktop"])).toBe("desktop");
    expect(pickComputerTier(["small", "big"])).toBe("big");
    expect(pickComputerTier([null, "unknown"])).toBe("small");
  });

  it("uses a dedicated bot's own tier", async () => {
    const prisma = bots({ byId: { computerTier: "desktop", archivedAt: null } });
    await expect(sandboxTierFor(prisma, "bot-1")).resolves.toBe("desktop");
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
  });

  it("reads a team computer's tier from its home key", async () => {
    const prisma = bots({
      byId: null,
      byHome: [{ computerTier: "small" }, { computerTier: "desktop" }],
    });
    await expect(sandboxTierFor(prisma, "team-digest")).resolves.toBe("desktop");
    expect(prisma.bot.findUnique).toHaveBeenCalledWith({
      where: { id: "team-digest" },
      select: { computerTier: true, archivedAt: true },
    });
    expect(prisma.bot.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, computer: { homeKey: "team-digest" } },
      select: { computerTier: true },
    });
  });

  it("ignores an archived bot id and falls through to the shared computer", async () => {
    const prisma = bots({
      byId: { computerTier: "small", archivedAt: new Date() },
      byHome: [{ computerTier: "big" }],
    });
    await expect(sandboxTierFor(prisma, "old-bot")).resolves.toBe("big");
  });
});

describe("burst provision guard", () => {
  it("applies the one-burst limit when the address is a team home key", async () => {
    const findUnique = vi.fn(async () => null);
    const findMany = vi.fn(async () => [{ id: "bot-1", userId: "user-1" }]);
    const findFirst = vi.fn(async () => ({ botId: "other-bot" }));
    const guard = burstProvisionGuard({
      bot: { findUnique, findMany },
      sandboxRun: { findFirst },
      containerUsage: { aggregate: vi.fn() },
      user: { findUnique: vi.fn() },
    });
    await expect(guard("team-digest", "desktop")).rejects.toThrow(/大容器/);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", endedAt: null, botId: { notIn: ["bot-1"] } },
      }),
    );
  });
});
