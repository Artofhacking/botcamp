// Samples running sandboxes once and adds the cores they hold to per-user totals.
// Runs from a timer: core-seconds are integrated from observations, so a stopped
// sampler under-counts rather than double-counts.
import { execFileSync } from "node:child_process";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@botcamp/adapters";
import { createDb, runAsSystem } from "@botcamp/db";

const NAMESPACE = process.env.KUBERNETES_SANDBOX_NAMESPACE ?? "botcamp";
const K8S_API = process.env.K8S_API ?? "https://10.0.1.13";
const INTERVAL_SECONDS = Number(process.env.SAMPLE_INTERVAL_SECONDS ?? 60);
const DATADIR = process.env.DATA_DIR ?? "./data";

/** Cores a CPU quantity asks for: "500m" -> 0.5, "2" -> 2. */
function coresFromQuantity(quantity: string | undefined): number {
  if (!quantity) return 0;
  const value = quantity.trim();
  if (value.endsWith("m")) return Number(value.slice(0, -1)) / 1000;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function imageTier(image: string | undefined): "big" | "desktop" {
  return image && image.includes("computer:") ? "desktop" : "big";
}

async function kubernetesSandboxCores(): Promise<
  Array<{ botId: string; tier: string; cores: number; podName: string; startedAt?: string }>
> {
  const args = [
    "--cacert",
    process.env.K8S_CA ?? "/root/.kube/pki/ca.crt",
    "--cert",
    process.env.K8S_CERT ?? "/root/.kube/pki/client.crt",
    "--key",
    process.env.K8S_KEY ?? "/root/.kube/pki/client.key",
    "-s",
    `${K8S_API}/api/v1/namespaces/${NAMESPACE}/pods`,
  ];
  const raw = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const list = JSON.parse(raw) as { items?: Array<Record<string, any>> };
  const out: Array<{
    botId: string;
    tier: string;
    cores: number;
    podName: string;
    startedAt?: string;
  }> = [];
  for (const pod of list.items ?? []) {
    const phase = pod.status?.phase;
    if (phase !== "Running") continue;
    const labels = pod.metadata?.labels ?? {};
    const botId = labels["botcamp-bot-id"] ?? labels["rakazo-bot-id"];
    const container = (pod.spec?.containers ?? [])[0];
    if (!botId || !container) continue;
    out.push({
      botId,
      tier: imageTier(container.image),
      cores: coresFromQuantity(
        container.resources?.limits?.cpu ?? container.resources?.requests?.cpu,
      ),
      podName: pod.metadata?.name ?? botId,
      startedAt: pod.status?.startTime,
    });
  }
  return out;
}

function dockerContainerIds(label: string): string[] {
  return execFileSync("docker", ["ps", "--filter", label, "--format", "{{.ID}}"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function dockerSandboxCores(): Array<{ botId: string; tier: string; cores: number }> {
  const names = [
    ...new Set([
      ...dockerContainerIds("label=botcamp.managed=true"),
      ...dockerContainerIds("label=rakazo.managed=true"),
    ]),
  ];
  const out: Array<{ botId: string; tier: string; cores: number }> = [];
  for (const id of names) {
    try {
      const info = JSON.parse(
        execFileSync("docker", ["inspect", id], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
      )[0];
      const labels = info?.Config?.Labels ?? {};
      const botId = labels["botcamp.botId"] ?? labels["rakazo.botId"];
      const nanoCpus = Number(info?.HostConfig?.NanoCpus ?? 0);
      if (!botId || !nanoCpus) continue;
      out.push({ botId, tier: "small", cores: nanoCpus / 1e9 });
    } catch {
      // A container that vanished mid-sample is simply not counted this tick.
    }
  }
  return out;
}

await unwrapEnvFromKeyManager();
const { prisma, pool } = createDb(process.env.DATABASE_URL!, {
  keyProvider: contentKeyProviderFromEnv(),
});

async function sampleOnce() {
  await runAsSystem("container usage sample", async () => {
    // The always-on mini container just browses files: it shares a flat-rate host and has
    // no per-core cost, so metering it would invent spend. Only burst sandboxes count.
    const samples = await kubernetesSandboxCores();
    if (samples.length === 0) return;
    const bots = await prisma.bot.findMany({
      where: { id: { in: [...new Set(samples.map((sample) => sample.botId))] } },
      select: { id: true, userId: true },
    });
    const owners = new Map(bots.map((bot) => [bot.id, bot.userId]));
    const day = new Date(new Date().toISOString().slice(0, 10));
    const perUser = new Map<string, { tier: string; coreSeconds: number }>();
    for (const sample of samples) {
      const userId = owners.get(sample.botId);
      if (!userId) continue;
      const key = `${userId}|${sample.tier}`;
      const entry = perUser.get(key) ?? { tier: sample.tier, coreSeconds: 0 };
      entry.coreSeconds += sample.cores * INTERVAL_SECONDS;
      perUser.set(key, entry);
    }
    const now = Date.now();
    for (const [key, entry] of perUser) {
      const [userId] = key.split("|");
      if (!userId) continue;
      const existing = await prisma.containerUsage.findUnique({
        where: { userId_tier_day: { userId, tier: entry.tier, day } },
        select: { sampledAt: true },
      });
      // Integrate the time that actually passed since the last sample, so a slow or
      // drifting tick does not silently change the rate.
      const elapsed = existing
        ? Math.min(Math.max((now - existing.sampledAt.getTime()) / 1000, 0), 300)
        : INTERVAL_SECONDS;
      const cores = entry.coreSeconds / INTERVAL_SECONDS;
      const add = Math.round(cores * elapsed);
      await prisma.containerUsage.upsert({
        where: { userId_tier_day: { userId, tier: entry.tier, day } },
        create: { userId, tier: entry.tier, day, coreSeconds: BigInt(add) },
        update: { coreSeconds: { increment: BigInt(add) } },
      });
    }
    // Persist what is running so the console can read the database instead of the cluster.
    const seen = new Set<string>();
    for (const sample of samples) {
      const userId = owners.get(sample.botId) ?? null;
      const id = sample.podName;
      seen.add(id);
      const nowDate = new Date(now);
      const running = await prisma.sandboxRun.findUnique({
        where: { id },
        select: { id: true, cores: true, lastSeenAt: true, startedAt: true },
      });
      if (!running) {
        await prisma.sandboxRun.create({
          data: {
            id,
            botId: sample.botId,
            userId,
            tier: sample.tier,
            cores: sample.cores,
            startedAt: new Date(sample.startedAt ?? now),
            lastSeenAt: nowDate,
            coreSeconds: 0n,
          },
        });
        continue;
      }
      const elapsed = Math.min(Math.max((now - running.lastSeenAt.getTime()) / 1000, 0), 300);
      await prisma.sandboxRun.update({
        where: { id },
        data: {
          lastSeenAt: nowDate,
          coreSeconds: { increment: BigInt(Math.round(running.cores * elapsed)) },
        },
      });
    }
    // Anything we did not see this tick has finished.
    await prisma.sandboxRun.updateMany({
      where: { endedAt: null, id: { notIn: [...seen] } },
      data: { endedAt: new Date(now) },
    });

    console.log(`sampled ${samples.length} sandboxes for ${perUser.size} user/tier pairs`);
  });
}

try {
  if (process.argv.includes("--loop")) {
    // One long-lived process: tsx compiles once instead of on every tick.
    let stopping = false;
    const tick = async () => {
      try {
        await sampleOnce();
      } catch (error) {
        console.error("sample failed", error);
      }
      if (!stopping) setTimeout(tick, INTERVAL_SECONDS * 1000);
    };
    const stop = async () => {
      stopping = true;
      await pool.end().catch(() => undefined);
      process.exit(0);
    };
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
    console.log(`sampling every ${INTERVAL_SECONDS}s`);
    await tick();
  } else {
    await sampleOnce();
  }
} finally {
  if (!process.argv.includes("--loop")) await pool.end();
}
