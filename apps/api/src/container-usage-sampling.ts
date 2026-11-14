/**
 * Turns container observations into core-second samples. Kept apart from the sampler
 * CLI so the arithmetic can be tested without a Docker host or a database.
 */

export interface CoreSample {
  botId: string;
  tier: "small" | "big" | "desktop";
  cores: number;
  podName: string;
  startedAt?: string;
}

/** Cores a CPU quantity asks for: "500m" -> 0.5, "2" -> 2. */
export function coresFromQuantity(quantity: string | undefined): number {
  if (!quantity) return 0;
  const value = quantity.trim();
  if (value.endsWith("m")) return Number(value.slice(0, -1)) / 1000;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The burst image is the plain computer image; the desktop one carries "computer:". */
export function imageTier(image: string | undefined): "big" | "desktop" {
  return image && image.includes("computer:") ? "desktop" : "big";
}

/**
 * Cores a Docker container holds. A host with no CPU limit still runs on one core's
 * worth of scheduling, so an unlimited computer counts as one rather than zero.
 */
export function coresFromContainerLimits(
  host:
    | {
        NanoCpus?: number;
        CpuQuota?: number;
        CpuPeriod?: number;
      }
    | undefined,
): number {
  const nano = Number(host?.NanoCpus ?? 0);
  if (nano > 0) return nano / 1e9;
  const quota = Number(host?.CpuQuota ?? 0);
  const period = Number(host?.CpuPeriod ?? 0);
  if (quota > 0 && period > 0) return quota / period;
  return 1;
}

interface DockerInspect {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  HostConfig?: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number };
  State?: { Running?: boolean; StartedAt?: string };
}

/** Running bot computers among `docker inspect` results, with the cores each holds. */
export function dockerSamplesFromInspect(list: unknown[]): CoreSample[] {
  const samples: CoreSample[] = [];
  for (const entry of list) {
    const container = entry as DockerInspect;
    if (!container?.State?.Running) continue;
    const labels = container.Config?.Labels ?? {};
    const botId = labels["botcamp.botId"] ?? labels["rakazo-bot-id"];
    if (!botId) continue;
    samples.push({
      botId,
      tier: imageTier(container.Config?.Image),
      cores: coresFromContainerLimits(container.HostConfig),
      podName: String(container.Name ?? container.Id ?? botId).replace(/^\//, ""),
      startedAt: container.State?.StartedAt,
    });
  }
  return samples;
}
