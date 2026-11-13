// A small operator console: who is here, what they spent this week, and their allowance.
//
// Deliberately plain HTTP + JSON rather than another RPC surface: the console is one page,
// it ships with no build step, and every route here is gated on RAKAZO_ADMIN_EMAILS.
import { listDeploymentModels, replaceDeploymentModels } from "@botcamp/adapters";
import { firstNonEmpty } from "@botcamp/core/env-name";
import type { PrismaClient } from "@botcamp/db";
import {
  containerCostYuan,
  isPlanId,
  listValueUsd,
  listValueYuan,
  PLANS,
  planOf,
  runAsSystem,
  tokenCostYuan,
  tokenListCostYuan,
  weekEnd,
  weekStart,
} from "@botcamp/db";
import { Hono } from "hono";
import { isAdmin } from "./admins.js";

export interface AdminConsoleDeps {
  prisma: PrismaClient;
  env: { adminEmails: string[]; adminUserIds?: string[] };
  /** Resolves the signed-in user from the request, or null. */
  sessionUser: (request: Request) => Promise<{ id: string; email: string } | null>;
}

const MAX_QUOTA = 10_000_000_000;

// Tencent TKE Serverless (AMD, Guangzhou) list prices, 元 per hour.
const CPU_YUAN_PER_CORE_HOUR = Number(process.env.TKE_CPU_YUAN_PER_CORE_HOUR ?? 0.061);
const MEMORY_YUAN_PER_GIB_HOUR = Number(process.env.TKE_MEMORY_YUAN_PER_GIB_HOUR ?? 0.032);
// Memory is fixed per tier, so cost follows from the tier rather than a second counter.
const TIER_MEMORY_GIB: Record<string, number> = { big: 2, desktop: 4, small: 0 };
const USD_TO_CNY = Number(process.env.USD_TO_CNY ?? 7.1);
// Flat monthly spend: entry CVM, cluster management fee, CFS, managed Postgres.
const fixedMonthlyYuan = firstNonEmpty(
  process.env.BOTCAMP_FIXED_MONTHLY_YUAN,
  process.env.RAKAZO_FIXED_MONTHLY_YUAN,
)?.trim();
const FIXED_MONTHLY_YUAN = Number(fixedMonthlyYuan ? fixedMonthlyYuan : 190);

/** Container spend for a set of rows, in 元. */
function containerYuan(rows: Array<{ tier: string; coreSeconds: bigint | number }>): number {
  return rows.reduce((sum, row) => {
    const hours = Number(row.coreSeconds) / 3600;
    const cores = row.tier === "desktop" ? 2 : 1;
    return (
      sum +
      hours * cores * CPU_YUAN_PER_CORE_HOUR +
      hours * (TIER_MEMORY_GIB[row.tier] ?? 0) * MEMORY_YUAN_PER_GIB_HOUR
    );
  }, 0);
}

export function adminConsoleRoutes(deps: AdminConsoleDeps) {
  const app = new Hono();

  // Every route below is operator-only; a signed-in non-admin gets 403, a stray guest 401.
  app.use("/admin/api/*", async (c, next) => {
    const user = await deps.sessionUser(c.req.raw);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!(await isAdmin(deps, user.id))) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  app.get("/admin/api/overview", async (c) =>
    runAsSystem("operator console overview", async () => {
      const start = weekStart();
      const [users, bots, computers, spend, coreRows] = await Promise.all([
        deps.prisma.user.count(),
        deps.prisma.bot.count(),
        deps.prisma.computer.count(),
        deps.prisma.usageRecord.aggregate({
          where: { createdAt: { gte: start } },
          _sum: { totalTokens: true, costUsd: true },
          _count: true,
        }),
        deps.prisma.containerUsage.groupBy({
          by: ["tier"],
          where: { day: { gte: new Date(start.toISOString().slice(0, 10)) } },
          _sum: { coreSeconds: true },
        }),
      ]);
      return c.json({
        users,
        bots,
        computers,
        weekStart: start.toISOString(),
        weekEnd: weekEnd().toISOString(),
        weekTokens: spend._sum.totalTokens ?? 0,
        weekCostUsd: Number(spend._sum.costUsd ?? 0),
        weekCalls: spend._count,
        weekCoreSeconds: coreRows.reduce((sum, row) => sum + Number(row._sum.coreSeconds ?? 0), 0),
        weekCoreHours:
          coreRows.reduce((sum, row) => sum + Number(row._sum.coreSeconds ?? 0), 0) / 3600,
      });
    }),
  );

  app.get("/admin/api/users", async (c) =>
    runAsSystem("operator console user list", async () => {
      const query = (c.req.query("q") ?? "").trim();
      const start = weekStart();
      const users = await deps.prisma.user.findMany({
        where: query
          ? {
              OR: [
                { email: { contains: query, mode: "insensitive" } },
                { name: { contains: query, mode: "insensitive" } },
              ],
            }
          : undefined,
        select: {
          id: true,
          email: true,
          name: true,
          emailVerified: true,
          createdAt: true,
          weeklyTokenQuota: true,
          plan: true,
          weeklyCoreSecondsQuota: true,
          weeklyCreditQuota: true,
        },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const botCounts = await deps.prisma.bot.groupBy({
        by: ["userId"],
        where: { userId: { in: users.map((user) => user.id) } },
        _count: true,
      });
      const botsByUser = new Map(botCounts.map((row) => [row.userId, row._count]));
      const coreRows = await deps.prisma.containerUsage.groupBy({
        by: ["userId", "tier"],
        where: {
          day: { gte: new Date(start.toISOString().slice(0, 10)) },
          userId: { in: users.map((user) => user.id) },
        },
        _sum: { coreSeconds: true },
      });
      const coreSecondsByUser = new Map<string, number>();
      const containerYuanByUser = new Map<string, number>();
      for (const row of coreRows) {
        const seconds = Number(row._sum.coreSeconds ?? 0);
        coreSecondsByUser.set(row.userId, (coreSecondsByUser.get(row.userId) ?? 0) + seconds);
        containerYuanByUser.set(
          row.userId,
          (containerYuanByUser.get(row.userId) ?? 0) +
            containerYuan([{ tier: row.tier, coreSeconds: seconds }]),
        );
      }
      const usage = await deps.prisma.usageRecord.groupBy({
        by: ["userId"],
        where: { createdAt: { gte: start }, userId: { in: users.map((user) => user.id) } },
        _sum: {
          totalTokens: true,
          costUsd: true,
          inputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          outputTokens: true,
        },
      });
      const byUser = new Map(
        usage.map((row) => [
          row.userId,
          {
            tokens: row._sum.totalTokens ?? 0,
            costUsd: Number(row._sum.costUsd ?? 0),
            // Kept so a credit total can be derived from the same cache-aware rates.
            sums: {
              inputTokens: row._sum.inputTokens ?? 0,
              cacheReadTokens: row._sum.cacheReadTokens ?? 0,
              cacheWriteTokens: row._sum.cacheWriteTokens ?? 0,
              outputTokens: row._sum.outputTokens ?? 0,
            },
          },
        ]),
      );
      const usedPointsByUser = new Map<string, number>();
      for (const user of users) {
        const sums = byUser.get(user.id)?.sums;
        if (!sums) continue;
        const yuan =
          tokenListCostYuan(sums) + containerCostYuan("big", coreSecondsByUser.get(user.id) ?? 0);
        usedPointsByUser.set(user.id, yuan * 100);
      }
      return c.json({
        weekStart: start.toISOString(),
        users: users.map((user) => ({
          id: user.id,
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          bots: botsByUser.get(user.id) ?? 0,
          plan: planOf(user.plan).id,
          planLabel: planOf(user.plan).label,
          weeklyTokens: Number(user.weeklyTokenQuota),
          listValueYuan: Number(listValueYuan(user.weeklyTokenQuota).toFixed(2)),
          listValueUsd: Number(listValueUsd(user.weeklyTokenQuota).toFixed(2)),
          weeklyCoreHours: Number(user.weeklyCoreSecondsQuota) / 3600,
          usedPercent: Number(
            user.weeklyCreditQuota > 0n
              ? Math.min(
                  100,
                  Math.round(
                    (Number(usedPointsByUser.get(user.id) ?? 0) / Number(user.weeklyCreditQuota)) *
                      100,
                  ),
                )
              : 0,
          ),
          realCostYuan: Number(
            (
              tokenCostYuan(byUser.get(user.id)?.sums ?? {}) +
              containerCostYuan("big", coreSecondsByUser.get(user.id) ?? 0)
            ).toFixed(2),
          ),
          weeklyTokenQuota: Number(user.weeklyTokenQuota),
          weeklyCoreSecondsQuota: Number(user.weeklyCoreSecondsQuota),
          weekTokens: byUser.get(user.id)?.tokens ?? 0,
          weekCostUsd: byUser.get(user.id)?.costUsd ?? 0,
          weekCoreSeconds: coreSecondsByUser.get(user.id) ?? 0,
          weekCoreHours: (coreSecondsByUser.get(user.id) ?? 0) / 3600,
          weekContainerYuan: containerYuanByUser.get(user.id) ?? 0,
          weekModelYuan: (byUser.get(user.id)?.costUsd ?? 0) * USD_TO_CNY,
          weekTotalYuan:
            (containerYuanByUser.get(user.id) ?? 0) +
            (byUser.get(user.id)?.costUsd ?? 0) * USD_TO_CNY,
        })),
      });
    }),
  );

  // Reads the sampler's table, never the cluster: an open console costs nothing extra.
  app.get("/admin/api/live", async (c) =>
    runAsSystem("operator console live sandboxes", async () => {
      const rows = await deps.prisma.sandboxRun.findMany({
        where: { endedAt: null },
        orderBy: { startedAt: "desc" },
        take: 50,
      });
      const now = Date.now();
      const sandboxes = rows.map((row) => ({
        botId: row.botId,
        pod: row.id,
        tier: row.tier,
        cores: row.cores,
        startedAt: row.startedAt.toISOString(),
        runningSeconds: Math.max(0, Math.round((now - row.startedAt.getTime()) / 1000)),
        // Between samples, project the accrual from the last observed heartbeat.
        coreSeconds:
          Number(row.coreSeconds) +
          Math.round(row.cores * Math.max(0, (now - row.lastSeenAt.getTime()) / 1000)),
      }));
      const latest = rows.reduce<Date | null>(
        (acc, row) => (!acc || row.lastSeenAt > acc ? row.lastSeenAt : acc),
        null,
      );
      return c.json({
        sandboxes,
        totalCoreSeconds: sandboxes.reduce((sum, entry) => sum + entry.coreSeconds, 0),
        sampledAt: latest?.toISOString() ?? null,
      });
    }),
  );

  app.patch("/admin/api/users/:id/plan", async (c) =>
    runAsSystem("operator console plan change", async () => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => null)) as { plan?: unknown } | null;
      if (!isPlanId(body?.plan)) {
        return c.json({ error: `plan must be one of ${Object.keys(PLANS).join(", ")}` }, 400);
      }
      const plan = PLANS[body.plan];
      const updated = await deps.prisma.user
        .update({
          where: { id },
          data: {
            plan: plan.id,
            quotaAnchorAt: new Date(),
            weeklyTokenQuota: plan.weeklyTokens,
            weeklyCoreSecondsQuota: plan.weeklyCoreSeconds,
            weeklyCreditQuota: plan.weeklyPoints,
          },
          select: { plan: true, weeklyTokenQuota: true, weeklyCoreSecondsQuota: true },
        })
        .catch(() => null);
      if (!updated) return c.json({ error: "no such user" }, 404);
      return c.json({
        id,
        plan: updated.plan,
        weeklyTokens: Number(updated.weeklyTokenQuota),
        weeklyCoreHours: Number(updated.weeklyCoreSecondsQuota) / 3600,
        listValueUsd: listValueUsd(updated.weeklyTokenQuota),
      });
    }),
  );

  app.get("/admin/api/models", async (c) =>
    runAsSystem("operator console model list", async () => {
      const models = await listDeploymentModels(deps.prisma);
      return c.json({ models });
    }),
  );

  app.put("/admin/api/models", async (c) =>
    runAsSystem("operator console model order", async () => {
      const body = (await c.req.json().catch(() => null)) as { models?: unknown } | null;
      const saved = await replaceDeploymentModels(deps.prisma, body?.models);
      if (!Array.isArray(saved)) return c.json(saved, 400);
      return c.json({ models: saved });
    }),
  );

  app.patch("/admin/api/users/:id/quota", async (c) =>
    runAsSystem("operator console quota change", async () => {
      const id = c.req.param("id");
      const body = (await c.req.json().catch(() => null)) as { weeklyTokenQuota?: unknown } | null;
      const value = Number(body?.weeklyTokenQuota);
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUOTA) {
        return c.json({ error: "weeklyTokenQuota must be a non-negative integer" }, 400);
      }
      const updated = await deps.prisma.user
        .update({ where: { id }, data: { weeklyTokenQuota: BigInt(value) } })
        .catch(() => null);
      if (!updated) return c.json({ error: "no such user" }, 404);
      return c.json({ id, weeklyTokenQuota: value });
    }),
  );

  return app;
}
