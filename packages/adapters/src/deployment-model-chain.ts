import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { SecretStore } from "@rakazo/adapter-kit";
import { canonicalPiProviderId, usableModelId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { findConnectedModelCredential } from "./model-selection.js";
import { parseModelSecret } from "./pi-oauth.js";
import { OPENCODE_GO_PROVIDER, openCodeUsageVerdict } from "./subscription-quota.js";

/**
 * Reads every image. Text models never receive image parts, including ones that
 * could see them, so a text timeout can still move to a text backup.
 */
export const DEPLOYMENT_IMAGE_MODEL = {
  provider: "openai-compatible",
  modelId: "deepseek/deepseek-v4-flash-vision-exp",
} as const;

/** The order a managed deployment starts with. An admin can reorder or disable these. */
export const INITIAL_DEPLOYMENT_MODELS = [
  { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
  { provider: "openai-compatible", modelId: "deepseek/deepseek-v4.1-flash" },
  { provider: "openai-compatible", modelId: "tencent/deepseek-v4-flash" },
  { provider: "openai-compatible", modelId: "openrouter/deepseek-v4.1-flash-1017" },
] as const;

export type DeploymentModelSlot = {
  position: number;
  provider: string;
  modelId: string;
  enabled: boolean;
};

const MAX_MODELS = 8;

type ModelTable = {
  findMany(args: { orderBy: { position: "asc" } }): Promise<DeploymentModelSlot[]>;
  count(): Promise<number>;
  createMany(args: { data: DeploymentModelSlot[]; skipDuplicates?: boolean }): Promise<unknown>;
  deleteMany(): Promise<unknown>;
};

type ModelClient = {
  deploymentModelChoice?: ModelTable;
  $transaction?<T>(fn: (tx: ModelClient) => Promise<T>): Promise<T>;
  secret: PrismaClient["secret"];
};

function tableOf(prisma: ModelClient): ModelTable | null {
  const table = prisma.deploymentModelChoice;
  if (!table?.findMany || !table.count || !table.createMany) return null;
  return table;
}

/** A managed deployment with an empty list gets the starting four. Other installs stay empty. */
export async function ensureInitialDeploymentModels(prisma: ModelClient): Promise<void> {
  if (process.env.MANAGED_MODELS_ONLY !== "1") return;
  const table = tableOf(prisma);
  if (!table) return;
  if ((await table.count()) > 0) return;
  await table.createMany({
    data: INITIAL_DEPLOYMENT_MODELS.map((model, position) => ({
      position,
      provider: model.provider,
      modelId: model.modelId,
      enabled: true,
    })),
    skipDuplicates: true,
  });
}

export async function listDeploymentModels(prisma: ModelClient): Promise<DeploymentModelSlot[]> {
  const table = tableOf(prisma);
  if (!table) return [];
  await ensureInitialDeploymentModels(prisma);
  return table.findMany({ orderBy: { position: "asc" } });
}

export function parseDeploymentModelList(
  input: unknown,
): { ok: true; models: DeploymentModelSlot[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_MODELS) {
    return { ok: false, error: "models must be a list of 1 to 8 entries" };
  }
  const models: DeploymentModelSlot[] = [];
  const seen = new Set<string>();
  for (const [position, entry] of input.entries()) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "each model is an object" };
    const record = entry as { provider?: unknown; modelId?: unknown; enabled?: unknown };
    const provider = canonicalPiProviderId(
      typeof record.provider === "string" ? record.provider.trim() : "",
    );
    const modelId = usableModelId(typeof record.modelId === "string" ? record.modelId : null);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider) || !modelId || modelId.length > 200) {
      return { ok: false, error: "a model needs a provider and a model id" };
    }
    if (typeof record.enabled !== "boolean") {
      return { ok: false, error: "enabled must be true or false" };
    }
    const key = `${provider}\n${modelId}`;
    if (seen.has(key)) return { ok: false, error: "each model is listed once" };
    seen.add(key);
    models.push({ position, provider, modelId, enabled: record.enabled });
  }
  if (!models.some((model) => model.enabled)) {
    return { ok: false, error: "enable at least one model" };
  }
  return { ok: true, models };
}

export async function replaceDeploymentModels(
  prisma: ModelClient,
  input: unknown,
): Promise<DeploymentModelSlot[] | { error: string }> {
  const parsed = parseDeploymentModelList(input);
  if (!parsed.ok) return { error: parsed.error };
  const table = tableOf(prisma);
  if (!table?.deleteMany || !prisma.$transaction) return { error: "model list is unavailable" };
  const models = parsed.models;
  await prisma.$transaction(async (tx) => {
    const next = tableOf(tx);
    if (!next?.deleteMany) throw new Error("model list is unavailable");
    await next.deleteMany();
    await next.createMany({ data: models });
  });
  return models;
}

async function openCodeKey(
  prisma: ModelClient,
  secretStore: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string },
): Promise<string | undefined> {
  const fromEnv = getEnvApiKey(OPENCODE_GO_PROVIDER)?.trim();
  if (fromEnv && fromEnv !== "<authenticated>") return fromEnv;
  const credential = await findConnectedModelCredential(
    prisma as unknown as PrismaClient,
    secretStore,
    scope,
    OPENCODE_GO_PROVIDER,
  );
  if (!credential) return undefined;
  const row = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!row) return undefined;
  const parsed = parseModelSecret(await secretStore.load(row.ciphertext, row.id));
  return parsed.kind === "api_key" && parsed.key.trim() ? parsed.key.trim() : undefined;
}

/**
 * Models a run should try, in admin order. Disabled rows are omitted. OpenCode is omitted
 * when its usage read says the account is empty or the key is rejected. A failed read stays
 * in the list so the call can still move on to the next model. `null` means this deployment
 * has no list and the run keeps its previous selection.
 */
export async function runnableDeploymentModels(
  deps: { prisma: ModelClient; secretStore: Pick<SecretStore, "load"> },
  scope: { userId: string; spaceId: string },
): Promise<DeploymentModelSlot[] | null> {
  const table = tableOf(deps.prisma);
  if (!table) return null;
  await ensureInitialDeploymentModels(deps.prisma);
  const rows = await table.findMany({ orderBy: { position: "asc" } });
  if (rows.length === 0) return null;
  const skipProviders = new Set<string>();
  const openCodeRow = rows.find((row) => row.enabled && row.provider === OPENCODE_GO_PROVIDER);
  if (openCodeRow) {
      const key = await openCodeKey(deps.prisma, deps.secretStore, scope);
      if (!key) {
        getLogger().warn("deployment model skipped", {
          provider: OPENCODE_GO_PROVIDER,
          reason: "no-key",
        });
        skipProviders.add(OPENCODE_GO_PROVIDER);
      } else {
        const verdict = await openCodeUsageVerdict(key);
        if (verdict === "exhausted" || verdict === "unavailable") {
          getLogger().warn("deployment model skipped", {
            provider: OPENCODE_GO_PROVIDER,
            reason: verdict,
          });
          skipProviders.add(OPENCODE_GO_PROVIDER);
        }
      }
  }
  return selectableDeploymentModels(rows, skipProviders);
}

/** Enabled rows, in order, without providers the quota read already ruled out. */
export function selectableDeploymentModels(
  rows: DeploymentModelSlot[],
  skipProviders: ReadonlySet<string>,
): DeploymentModelSlot[] {
  return rows.filter((row) => row.enabled && !skipProviders.has(row.provider));
}
