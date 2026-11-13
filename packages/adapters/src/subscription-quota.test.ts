import type { SecretStore } from "@botcamp/adapter-kit";
import type { PrismaClient } from "@botcamp/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseSubscriptionFallback,
  grokSubscriptionQuota,
  loadSharedGrokSubscription,
  openCodeGoQuota,
  resetSubscriptionQuotaCache,
  subscriptionSecretValues,
} from "./subscription-quota.js";

const usage = (percent: number, status = "ok") => ({
  status,
  percent,
  resetsAt: "2026-11-06T00:00:00Z",
});

function openCodeBody(
  percents: { rolling?: number; weekly?: number; monthly?: number },
  status = "ok",
) {
  return {
    usage: {
      ...(percents.rolling !== undefined ? { rolling: usage(percents.rolling, status) } : {}),
      ...(percents.weekly !== undefined ? { weekly: usage(percents.weekly, status) } : {}),
      ...(percents.monthly !== undefined ? { monthly: usage(percents.monthly, status) } : {}),
    },
  };
}

function grokBody(input: {
  creditUsagePercent?: number;
  prepaid?: number;
  cap?: number;
  used?: number;
  build?: number;
  period?: boolean;
}) {
  return {
    config: {
      ...(input.creditUsagePercent !== undefined
        ? { creditUsagePercent: input.creditUsagePercent }
        : {}),
      ...(input.period === false
        ? {}
        : { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-12T00:00:00Z" } }),
      ...(input.prepaid !== undefined ? { prepaidBalance: { val: input.prepaid } } : {}),
      ...(input.cap !== undefined ? { onDemandCap: { val: input.cap } } : {}),
      ...(input.used !== undefined ? { onDemandUsed: { val: input.used } } : {}),
      ...(input.build !== undefined
        ? { productUsage: [{ product: "GrokBuild", usagePercent: input.build }] }
        : {}),
    },
  };
}

function fetcherFor(routes: Record<string, { status: number; body?: unknown } | "throw">) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!route || route === "throw") throw new Error("quota endpoint unavailable");
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, calls };
}

const grokAuth = {
  oauth: { type: "oauth" as const, access: "grok-access", refresh: "grok-refresh", expires: 1 },
  redact: ["grok-access", "grok-refresh"],
};

describe("subscription quota", () => {
  afterEach(() => {
    resetSubscriptionQuotaCache();
    vi.unstubAllEnvs();
  });

  it("reads OpenCode Go windows and skips a full one", () => {
    expect(openCodeGoQuota(openCodeBody({ rolling: 12, weekly: 34, monthly: 56 }))).toBe(
      "available",
    );
    expect(openCodeGoQuota(openCodeBody({ rolling: 12, weekly: 100, monthly: 3 }))).toBe(
      "exhausted",
    );
    expect(openCodeGoQuota(openCodeBody({ rolling: 10 }, "limited"))).toBe("exhausted");
    expect(openCodeGoQuota({})).toBe("unknown");
  });

  it("reads Grok Build usage and keeps a balance that can still pay", () => {
    expect(grokSubscriptionQuota(grokBody({ creditUsagePercent: 42.5 }))).toBe("available");
    expect(
      grokSubscriptionQuota(grokBody({ creditUsagePercent: 100, prepaid: 0, cap: 0, used: 0 })),
    ).toBe("exhausted");
    expect(grokSubscriptionQuota(grokBody({ creditUsagePercent: 100, prepaid: 1250 }))).toBe(
      "available",
    );
    expect(
      grokSubscriptionQuota(grokBody({ creditUsagePercent: 40, build: 100, prepaid: 0 })),
    ).toBe("exhausted");
    expect(grokSubscriptionQuota(grokBody({ period: true }))).toBe("available");
    expect(grokSubscriptionQuota({ config: null })).toBe("unknown");
  });

  it("uses OpenCode while it has usage and does not ask Grok", async () => {
    const { fetcher, calls } = fetcherFor({
      "https://opencode.ai/zen/go/v1/usage": {
        status: 200,
        body: openCodeBody({ rolling: 1, weekly: 2, monthly: 3 }),
      },
      "https://cli-chat-proxy.grok.com/v1/billing": {
        status: 200,
        body: grokBody({ creditUsagePercent: 1 }),
      },
    });
    const choice = await chooseSubscriptionFallback({
      openCodeApiKey: "oc-key",
      loadGrok: async () => grokAuth,
      fetcher,
      now: 1_000,
    });
    expect(choice).toMatchObject({ kind: "use", provider: "opencode-go", modelId: "gpt-6-luna" });
    expect(calls).toEqual(["https://opencode.ai/zen/go/v1/usage"]);
  });

  it("skips OpenCode when it is empty and uses Grok Build", async () => {
    const seen: Headers[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(new Headers(init?.headers));
      const body = url.includes("opencode.ai")
        ? openCodeBody({ rolling: 100, weekly: 1, monthly: 1 })
        : grokBody({ creditUsagePercent: 10 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const choice = await chooseSubscriptionFallback({
      openCodeApiKey: "oc-key",
      loadGrok: async () => grokAuth,
      fetcher,
      modelId: (provider) => (provider === "xai" ? "grok-4.7" : null),
      now: 2_000,
    });
    expect(choice).toMatchObject({
      kind: "use",
      provider: "xai",
      modelId: "grok-4.7",
      skipProviders: ["opencode-go"],
    });
    expect(seen[1]?.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(seen[1]?.get("authorization")).toBe("Bearer grok-access");
  });

  it("does not skip a provider whose usage read failed", async () => {
    const { fetcher, calls } = fetcherFor({
      "https://opencode.ai/zen/go/v1/usage": "throw",
      "https://cli-chat-proxy.grok.com/v1/billing": {
        status: 200,
        body: grokBody({ creditUsagePercent: 1 }),
      },
    });
    const choice = await chooseSubscriptionFallback({
      openCodeApiKey: "oc-key",
      loadGrok: async () => grokAuth,
      fetcher,
      now: 3_000,
    });
    expect(choice).toMatchObject({ kind: "use", provider: "opencode-go" });
    expect(calls).toEqual(["https://opencode.ai/zen/go/v1/usage"]);
  });

  it("skips a rejected credential and stops when every configured leg is empty", async () => {
    const { fetcher } = fetcherFor({
      "https://opencode.ai/zen/go/v1/usage": { status: 401 },
      "https://cli-chat-proxy.grok.com/v1/billing": {
        status: 200,
        body: grokBody({ creditUsagePercent: 100, prepaid: 0, cap: 0, used: 0 }),
      },
    });
    const choice = await chooseSubscriptionFallback({
      openCodeApiKey: "oc-key",
      loadGrok: async () => grokAuth,
      fetcher,
      now: 4_000,
    });
    expect(choice).toEqual({ kind: "exhausted", skipProviders: ["opencode-go", "xai"] });
  });

  it("leaves the run's own model alone when neither credential is configured", async () => {
    const choice = await chooseSubscriptionFallback({ fetcher: fetch, now: 5_000 });
    expect(choice).toEqual({ kind: "unconfigured" });
  });

  it("reuses a usage read for a few seconds", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(JSON.stringify(openCodeBody({ rolling: 1, weekly: 1, monthly: 1 })), {
        status: 200,
      });
    }) as typeof fetch;
    const input = { openCodeApiKey: "oc-key", fetcher, now: 6_000 };
    await chooseSubscriptionFallback(input);
    await chooseSubscriptionFallback(input);
    expect(calls).toBe(1);
  });

  it("redacts the shared OpenCode key", () => {
    vi.stubEnv("OPENCODE_API_KEY", "oc-test-key");
    expect(subscriptionSecretValues()).toEqual(["oc-test-key"]);
  });

  it("loads the deployment owner's Grok sign-in and ignores a key or a dead sign-in", async () => {
    const expires = Date.now() + 60 * 60_000;
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires,
    });
    const deps = (plaintext: string | undefined, owner = "owner") =>
      ({
        prisma: {
          deploymentSettings: { findUnique: async () => ({ ownerUserId: owner || null }) },
          userModelCredential: {
            findFirst: async () =>
              plaintext
                ? { id: "cred", secretId: "secret", userId: "owner", provider: "xai" }
                : null,
          },
          secret: {
            findFirst: async () => (plaintext ? { id: "secret", ciphertext: "blob" } : null),
          },
        },
        secretStore: { load: async () => plaintext ?? "" },
      }) as unknown as {
        prisma: PrismaClient;
        secretStore: Pick<SecretStore, "load" | "put" | "delete">;
      };

    const loaded = await loadSharedGrokSubscription(deps(oauth));
    expect(loaded?.oauth).toMatchObject({ access: "access-token", refresh: "refresh-token" });
    expect(loaded?.redact).toEqual(expect.arrayContaining(["access-token", "refresh-token"]));
    expect(await loadSharedGrokSubscription(deps(undefined, ""))).toBeNull();
    expect(
      await loadSharedGrokSubscription(
        deps(JSON.stringify({ kind: "api_key", key: "xai-test-key" })),
      ),
    ).toBeNull();
    expect(
      await loadSharedGrokSubscription(
        deps(JSON.stringify({ kind: "oauth", reconnectRequired: true })),
      ),
    ).toBeNull();
  });
});
