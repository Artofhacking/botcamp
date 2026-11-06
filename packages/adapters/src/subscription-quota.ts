import { createHash } from "node:crypto";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type {
  AgentModelOAuthCredential,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toOAuthCredential } from "./pi-credentials.js";
import {
  GROK_SUBSCRIPTION_AUTH_HEADER,
  GROK_SUBSCRIPTION_AUTH_KIND,
  GROK_SUBSCRIPTION_PROXY_URL,
} from "./pi-model-compat.js";
import {
  parseModelSecret,
  persistStoredModelSecret,
  secretValuesToRedact,
  serializeModelSecret,
  withModelCredentialLock,
  XAI_OAUTH_PROVIDER,
} from "./pi-oauth.js";

/** OpenCode Go is the subscription whose key can read remaining usage. */
export const OPENCODE_GO_PROVIDER = "opencode-go";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_MODEL_ID = "gpt-6-luna";
const GROK_SUBSCRIPTION_MODEL_ID = "grok-4.6";
const GROK_BILLING_URL = `${GROK_SUBSCRIPTION_PROXY_URL}/billing?format=credits`;
const QUOTA_TIMEOUT_MS = 5_000;
const QUOTA_CACHE_MS = 10_000;

const HOST_CREDENTIALS = "<authenticated>";

export type QuotaVerdict = "available" | "exhausted" | "unknown";
type ProbeVerdict = QuotaVerdict | "unavailable";

export type SubscriptionRunAuth = {
  apiKey?: string;
  oauth?: AgentModelOAuthCredential;
  persistOAuth?: (credential: AgentModelOAuthCredential) => Promise<void>;
  retireOAuth?: (
    reason: ModelCredentialRetireReason,
    detail?: string,
    failed?: ModelCredentialFailedState,
  ) => Promise<boolean | undefined>;
  redact: string[];
};

export type SubscriptionChoice =
  | { kind: "unconfigured" }
  | {
      kind: "use";
      provider: string;
      modelId: string;
      auth: SubscriptionRunAuth;
      /** Earlier legs whose usage read said they were empty or rejected. */
      skipProviders: string[];
    }
  | { kind: "exhausted"; skipProviders: string[] };

export type SubscriptionFallback = (input: {
  modelId(provider: string): string | null;
}) => Promise<SubscriptionChoice>;

type ChainLeg = {
  provider: string;
  modelId: string;
  probe: () => Promise<ProbeVerdict>;
  auth: () => SubscriptionRunAuth | undefined;
};

const cache = new Map<string, { at: number; verdict: ProbeVerdict }>();
const inflight = new Map<string, Promise<ProbeVerdict>>();

export function resetSubscriptionQuotaCache(): void {
  cache.clear();
  inflight.clear();
}

/** Keys a run must redact when this process holds the shared OpenCode credential. */
export function subscriptionSecretValues(): string[] {
  const key = usableKey(getEnvApiKey(OPENCODE_GO_PROVIDER));
  return key ? [key] : [];
}

function usableKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  if (!key || key === HOST_CREDENTIALS) return undefined;
  return key;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function windowExhausted(window: unknown): boolean | undefined {
  if (!window || typeof window !== "object") return undefined;
  const record = window as { status?: unknown; percent?: unknown };
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (status === "limited" || status === "exceeded" || status === "exhausted") return true;
  const percent = finite(record.percent);
  if (percent === undefined) return status === "ok" ? false : undefined;
  return percent >= 100;
}

/** OpenCode Go `GET /zen/go/v1/usage`. Any full window means that subscription cannot take a run. */
export function openCodeGoQuota(body: unknown): QuotaVerdict {
  if (!body || typeof body !== "object") return "unknown";
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return "unknown";
  const windows = ["rolling", "weekly", "monthly"].map(
    (name) => (usage as Record<string, unknown>)[name],
  );
  const verdicts = windows.map(windowExhausted).filter((verdict) => verdict !== undefined);
  if (verdicts.length === 0) return "unknown";
  return verdicts.some(Boolean) ? "exhausted" : "available";
}

function cents(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  return finite((value as { val?: unknown }).val);
}

function productUsagePercent(
  body: { productUsage?: unknown },
  product: string,
): number | undefined {
  if (!Array.isArray(body.productUsage)) return undefined;
  const wanted = product.toLowerCase();
  for (const entry of body.productUsage) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { product?: unknown; usagePercent?: unknown };
    const name =
      typeof row.product === "string" ? row.product.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    if (name === wanted) return finite(row.usagePercent);
  }
  return undefined;
}

/**
 * Grok Build `GET /v1/billing?format=credits`. `creditUsagePercent` is how much of the
 * included pool is used. Prepaid or unused on-demand balance still counts as remaining.
 */
export function grokSubscriptionQuota(body: unknown): QuotaVerdict {
  if (!body || typeof body !== "object") return "unknown";
  const config = (body as { config?: unknown }).config;
  if (!config || typeof config !== "object") return "unknown";
  const record = config as {
    creditUsagePercent?: unknown;
    currentPeriod?: unknown;
    prepaidBalance?: unknown;
    onDemandCap?: unknown;
    onDemandUsed?: unknown;
    productUsage?: unknown;
  };
  const prepaid = cents(record.prepaidBalance);
  const cap = cents(record.onDemandCap);
  const used = cents(record.onDemandUsed);
  const extra =
    (prepaid !== undefined && prepaid !== 0) ||
    (cap !== undefined && used !== undefined && used < cap);
  const build = productUsagePercent(record, "grokbuild");
  const overall = finite(record.creditUsagePercent);
  if (build !== undefined && build >= 100 && !extra) return "exhausted";
  if (overall !== undefined && overall >= 100 && !extra) return "exhausted";
  if (build !== undefined && build < 100) return "available";
  if (overall !== undefined && overall < 100) return "available";
  if (extra) return "available";
  // A current period with no usage figure is the start of the window, not an empty account.
  if (record.currentPeriod && typeof record.currentPeriod === "object") return "available";
  return "unknown";
}

async function fetchQuota(
  url: string,
  headers: Record<string, string>,
  fetcher: typeof fetch,
): Promise<ProbeVerdict | unknown> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) return "unavailable";
  if (!response.ok) return "unknown";
  return response.json();
}

async function probeCached(
  key: string,
  read: () => Promise<ProbeVerdict>,
  now: number,
): Promise<ProbeVerdict> {
  const hit = cache.get(key);
  if (hit && now - hit.at < QUOTA_CACHE_MS) return hit.verdict;
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = read()
    .then((verdict) => {
      if (verdict !== "unknown") cache.set(key, { at: now, verdict });
      return verdict;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** OpenCode Go usage for one key. A failed read is `unknown`, not empty. */
export async function openCodeUsageVerdict(
  apiKey: string,
  fetcher: typeof fetch = globalThis.fetch,
  now = Date.now(),
): Promise<ProbeVerdict> {
  const key = usableKey(apiKey);
  if (!key) return "unavailable";
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return probeCached(`opencode-go:${digest}`, () => probeOpenCode(key, fetcher), now);
}

async function probeOpenCode(apiKey: string, fetcher: typeof fetch): Promise<ProbeVerdict> {
  try {
    const body = await fetchQuota(
      OPENCODE_GO_USAGE_URL,
      { Authorization: `Bearer ${apiKey}` },
      fetcher,
    );
    if (body === "unavailable" || body === "unknown") return body;
    return openCodeGoQuota(body);
  } catch {
    return "unknown";
  }
}

async function probeGrok(access: string, fetcher: typeof fetch): Promise<ProbeVerdict> {
  try {
    const body = await fetchQuota(
      GROK_BILLING_URL,
      {
        Authorization: `Bearer ${access}`,
        [GROK_SUBSCRIPTION_AUTH_HEADER]: GROK_SUBSCRIPTION_AUTH_KIND,
      },
      fetcher,
    );
    if (body === "unavailable" || body === "unknown") return body;
    return grokSubscriptionQuota(body);
  } catch {
    return "unknown";
  }
}

function modelFor(
  provider: string,
  fallback: string,
  modelId?: (provider: string) => string | null,
): string {
  const preferred = modelId?.(provider)?.trim();
  return preferred || fallback;
}

/**
 * Prefer OpenCode Go, then the Grok subscription. A provider is skipped only when its
 * usage read says nothing remains, or the credential is rejected. A failed read is not
 * treated as empty: that provider is still tried.
 */
export async function chooseSubscriptionFallback(input: {
  openCodeApiKey?: string;
  modelId?: (provider: string) => string | null;
  loadGrok?: () => Promise<SubscriptionRunAuth | null>;
  fetcher?: typeof fetch;
  now?: number;
}): Promise<SubscriptionChoice> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const now = input.now ?? Date.now();
  const openCodeKey = usableKey(input.openCodeApiKey);
  const grok = input.loadGrok ? await input.loadGrok() : null;
  const legs: ChainLeg[] = [];
  if (openCodeKey) {
    legs.push({
      provider: OPENCODE_GO_PROVIDER,
      modelId: modelFor(OPENCODE_GO_PROVIDER, OPENCODE_GO_MODEL_ID, input.modelId),
      probe: () => probeCached("opencode-go", () => probeOpenCode(openCodeKey, fetcher), now),
      auth: () => ({ apiKey: openCodeKey, redact: [openCodeKey] }),
    });
  }
  if (grok?.oauth?.access) {
    const access = grok.oauth.access;
    legs.push({
      provider: XAI_OAUTH_PROVIDER,
      modelId: modelFor(XAI_OAUTH_PROVIDER, GROK_SUBSCRIPTION_MODEL_ID, input.modelId),
      probe: () => probeCached("xai", () => probeGrok(access, fetcher), now),
      auth: () => grok,
    });
  }
  if (legs.length === 0) return { kind: "unconfigured" };
  const skipProviders: string[] = [];
  for (const leg of legs) {
    const verdict = await leg.probe();
    if (verdict === "available" || verdict === "unknown") {
      const auth = leg.auth();
      if (!auth) continue;
      return { kind: "use", provider: leg.provider, modelId: leg.modelId, auth, skipProviders };
    }
    skipProviders.push(leg.provider);
  }
  return skipProviders.length > 0 ? { kind: "exhausted", skipProviders } : { kind: "unconfigured" };
}

/** The deployment owner's xAI sign-in, shared by runs that draw on that subscription. */
export async function loadSharedGrokSubscription(deps: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load" | "put" | "delete">;
}): Promise<SubscriptionRunAuth | null> {
  try {
    const settings = await deps.prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    const ownerUserId = settings?.ownerUserId;
    if (!ownerUserId) return null;
    const credential = await deps.prisma.userModelCredential.findFirst({
      where: { userId: ownerUserId, provider: XAI_OAUTH_PROVIDER },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
    if (!credential) return null;
    const row = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: ownerUserId, spaceId: null },
    });
    if (!row) return null;
    const plaintext = await deps.secretStore.load(row.ciphertext, row.id);
    const parsed = parseModelSecret(plaintext);
    // The host sync refreshes this shared sign-in. Refreshing here would rotate
    // the same refresh token the host file still holds.
    if (parsed.kind !== "oauth" || parsed.reconnectRequired) return null;
    const oauth = parsed.credential;
    const scope = { userId: ownerUserId, spaceId: "default" };
    const persist = persistStoredModelSecret(deps.prisma, deps.secretStore, scope, row.id);
    return {
      oauth,
      redact: secretValuesToRedact(parsed),
      persistOAuth: async (next) => {
        await withModelCredentialLock(row.id, async () => {
          const currentRow = await deps.prisma.secret.findFirst({
            where: { id: row.id, userId: ownerUserId, spaceId: null },
          });
          if (!currentRow) return;
          const current = parseModelSecret(
            await deps.secretStore.load(currentRow.ciphertext, currentRow.id),
          );
          if (current.kind !== "oauth" || current.reconnectRequired) return;
          if (current.credential.expires > next.expires) return;
          await persist(
            serializeModelSecret({ kind: "oauth", credential: toOAuthCredential(next) }),
          );
        });
      },
    };
  } catch {
    getLogger().warn("grok subscription credential could not be read");
    return null;
  }
}

export function subscriptionFallbackFor(deps: {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load" | "put" | "delete">;
}): SubscriptionFallback {
  return (input) =>
    chooseSubscriptionFallback({
      openCodeApiKey: getEnvApiKey(OPENCODE_GO_PROVIDER),
      modelId: input.modelId,
      loadGrok: () => loadSharedGrokSubscription(deps),
    });
}
