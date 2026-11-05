import type {
  AdapterContext,
  PortableFile,
  StreamedPortableFile,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/**
 * Where a bot's computer runs.
 * - `small`: the deployment's default provider — cheap and always on.
 * - `big`: the burst provider with a lean image — fast to start, no desktop.
 * - `desktop`: the burst provider with the full image — slower, has a browser.
 */
export type ComputerTier = "small" | "big" | "desktop";

export interface TieredSandboxOptions {
  providers: Partial<Record<ComputerTier, SandboxProvider>>;
  /** Resolves the tier a bot should run on right now. */
  tierFor(botId: string): Promise<ComputerTier>;
  /**
   * Runs before a burst container is created. Refusing here is how a deployment enforces
   * "one burst container per account" and its weekly core-hour budget.
   */
  beforeBurstProvision?: (botId: string, tier: ComputerTier) => Promise<void>;
}

/**
 * Routes each call to the provider that owns the computer's tier, so one deployment can keep
 * cheap always-on computers and still send heavy work to another backend.
 *
 * A tier with no configured provider falls back to `small`, so a partially configured
 * deployment still runs.
 */
class TieredSandbox {
  constructor(private readonly options: TieredSandboxOptions) {}

  private pick(tier: ComputerTier | undefined): SandboxProvider {
    const provider =
      (tier ? this.options.providers[tier] : undefined) ?? this.options.providers.small;
    if (!provider) throw new Error("no sandbox provider is configured");
    return provider;
  }

  private async owner(botId: string | undefined): Promise<SandboxProvider> {
    if (!botId) return this.pick("small");
    return this.pick(await this.options.tierFor(botId));
  }

  describe() {
    return this.pick("small").describe();
  }

  async provision(request: { botId: string }, context: AdapterContext) {
    const tier = await (this.options.tierFor(request.botId).catch(() => "small" as const));
    if (tier !== "small") await this.options.beforeBurstProvision?.(request.botId, tier);
    return (await this.owner(request.botId)).provision(request as never, context);
  }

  /** Streaming members must return the iterable itself, so this is a generator, not async. */
  execute(computer: ComputerRef, request: CommandRequest, context: AdapterContext) {
    const owner = () => this.owner(computer?.botId);
    return (async function* (): AsyncIterable<ProcessEvent> {
      const provider = await owner();
      yield* provider.execute(computer, request, context);
    })();
  }

  /** Same rule as execute(): a streaming member must return an iterable, not a promise. */
  exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    const owner = () => this.owner(computer?.botId);
    return (async function* (): AsyncIterable<PortableFile | StreamedPortableFile> {
      const provider = await owner();
      yield* provider.exportWorkspace(computer, context);
    })();
  }

  /** Every other member takes a computer first; forward it to that computer's provider. */
  async forward(method: string, computer: Pick<ComputerRef, "botId">, ...rest: unknown[]) {
    const provider = await this.owner(computer?.botId);
    const fn = (provider as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") return undefined;
    return (fn as (...args: unknown[]) => unknown).apply(provider, [computer, ...rest]);
  }
}

/** Desktop outranks a burst container, which outranks the cheap default. */
export function pickComputerTier(tiers: Iterable<string | null | undefined>): ComputerTier {
  let tier: ComputerTier = "small";
  for (const candidate of tiers) {
    if (candidate === "desktop") return "desktop";
    if (candidate === "big") tier = "big";
  }
  return tier;
}

/**
 * The tier a sandbox call should use.
 *
 * Callers pass either a bot id (a dedicated computer's home key is its bot id) or a computer
 * home key (a team computer's home key is a digest, and every sandbox call uses that as
 * `botId`). A team screen request sets the bot's tier; looking the digest up as a bot id
 * misses it and the computer stays on the small provider, which has no screen.
 */
export async function sandboxTierFor(
  prisma: Pick<PrismaClient, "bot">,
  address: string,
): Promise<ComputerTier> {
  const direct = await prisma.bot.findUnique({
    where: { id: address },
    select: { computerTier: true, archivedAt: true },
  });
  if (direct && !direct.archivedAt) return pickComputerTier([direct.computerTier]);
  const shared = await prisma.bot.findMany({
    where: { archivedAt: null, computer: { homeKey: address } },
    select: { computerTier: true },
  });
  return pickComputerTier(shared.map((bot) => bot.computerTier));
}

export function tieredSandbox(options: TieredSandboxOptions): SandboxProvider {
  if (!options.providers.small) throw new Error("tieredSandbox needs a small provider");
  const router = new TieredSandbox(options);
  return new Proxy(router, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (typeof property !== "string") return undefined;
      return (computer: Pick<ComputerRef, "botId">, ...rest: unknown[]) =>
        target.forward(property, computer, ...rest);
    },
  }) as unknown as SandboxProvider;
}

/**
 * Refuses a burst container when the account already runs one, or when its weekly core-hour
 * budget is spent. Both rules come from the plan: one burst container at a time, plus a cap.
 */
export function burstProvisionGuard(prisma: {
  bot: {
    findUnique(
      args: never,
    ): Promise<{ id: string; userId: string; computerId: string | null } | null>;
    findMany(args: never): Promise<Array<{ id: string; userId: string }>>;
  };
  sandboxRun: { findFirst(args: never): Promise<{ botId: string } | null> };
  containerUsage: { aggregate(args: never): Promise<{ _sum: { coreSeconds: bigint | null } }> };
  user: { findUnique(args: never): Promise<{ weeklyCoreSecondsQuota: bigint } | null> };
}) {
  return async (address: string, tier: ComputerTier): Promise<void> => {
    const account = await burstAccount(prisma, address);
    if (!account) return;

    const running = await prisma.sandboxRun.findFirst({
      where: { userId: account.userId, endedAt: null, botId: { notIn: account.botIds } },
      select: { botId: true },
    } as never);
    if (running) {
      throw new Error(
        `同一时间只能运行一个大容器：请先停止 bot ${running.botId} 的容器，再启动新的。`,
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: account.userId },
      select: { weeklyCoreSecondsQuota: true },
    } as never);
    if (!user) return;
    const used = await prisma.containerUsage.aggregate({
      where: {
        userId: account.userId,
        day: { gte: new Date(new Date().toISOString().slice(0, 10)) },
      },
      _sum: { coreSeconds: true },
    } as never);
    if (Number(used._sum.coreSeconds ?? 0) >= Number(user.weeklyCoreSecondsQuota)) {
      throw new Error(
        `本周大容器时长已用完（${Math.round(Number(user.weeklyCoreSecondsQuota) / 3600)} 小时），下周自动恢复。`,
      );
    }
  };
}

/** The account that owns this sandbox address, and the bots that share its computer. */
async function burstAccount(
  prisma: {
    bot: {
      findUnique(
        args: never,
      ): Promise<{ id: string; userId: string; computerId: string | null } | null>;
      findMany(args: never): Promise<Array<{ id: string; userId: string }>>;
    };
  },
  address: string,
): Promise<{ userId: string; botIds: string[] } | null> {
  const direct = await prisma.bot.findUnique({
    where: { id: address },
    select: { id: true, userId: true, computerId: true },
  } as never);
  if (direct) {
    const mates = direct.computerId
      ? await prisma.bot.findMany({
          where: { computerId: direct.computerId, archivedAt: null },
          select: { id: true },
        } as never)
      : [];
    return {
      userId: direct.userId,
      botIds: mates.length > 0 ? mates.map((bot) => bot.id) : [direct.id],
    };
  }
  const shared = await prisma.bot.findMany({
    where: { archivedAt: null, computer: { homeKey: address } },
    select: { id: true, userId: true },
  } as never);
  const userId = shared[0]?.userId;
  if (!userId) return null;
  return { userId, botIds: shared.map((bot) => bot.id) };
}
