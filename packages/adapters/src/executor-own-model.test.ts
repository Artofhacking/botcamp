import type { AgentRunRequest } from "@botcamp/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { serializeModelSecret } from "./pi-oauth.js";
import { withModelRoles } from "./testing/model-roles.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async (
    _prisma: unknown,
    input: { computerId: string; botId: string; runId: string },
  ) => ({ ...input, fence: 7 }),
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
  renewComputerExecutionLease: async () => true,
}));

const USER_ID = "user-1";
const OWN = { provider: "openrouter", modelId: "openai/gpt-4o" };
const MANAGED = { provider: "anthropic", modelId: "claude-sonnet-5" };
const stamp = new Date("2026-08-30T00:00:00.000Z");

type Credential = {
  id: string;
  userId: string;
  provider: string;
  label: string;
  secretId: string;
  supportsImages: boolean;
  createdAt: Date;
  updatedAt: Date;
};
type ProviderFilter = string | { in: string[] };

const matchesProvider = (filter: ProviderFilter | undefined, provider: string) =>
  filter === undefined ||
  (typeof filter === "string" ? filter === provider : filter.in.includes(provider));

function connection(provider: string, secretId: string): Credential {
  return {
    id: `credential-${provider}`,
    userId: USER_ID,
    provider,
    label: provider,
    secretId,
    supportsImages: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

const plaintexts: Record<string, string> = {
  "secret-own": serializeModelSecret({ kind: "api_key", key: "fake-own-key" }),
  "secret-managed": serializeModelSecret({ kind: "api_key", key: "fake-managed-key" }),
};

async function runTurn({ granted }: { granted: boolean }) {
  const run: Record<string, unknown> = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: USER_ID,
    status: "queued",
    trigger: "user",
    leaseFence: 0,
  };
  const state = {
    credentials: [
      connection(OWN.provider, "secret-own"),
      connection(MANAGED.provider, "secret-managed"),
    ],
    secrets: ["secret-own", "secret-managed"].map((id) => ({
      id,
      userId: USER_ID,
      spaceId: null,
      kind: "model",
      ciphertext: `cipher-${id}`,
    })),
  };
  const credentialsFor = (where: { userId?: string; provider?: ProviderFilter }) =>
    state.credentials.filter(
      (row) => row.userId === where.userId && matchesProvider(where.provider, row.provider),
    );
  const usageCreate = vi.fn(async (_args: { data: Array<Record<string, unknown>> }) => ({
    count: 1,
  }));
  const tx = {
    usageRecord: { createMany: usageCreate },
    modelCreditEntry: { findUnique: vi.fn(async () => null) },
    userModelCredential: {
      findFirst: vi.fn(
        async (args: { where: { id: string } }) =>
          state.credentials.find((row) => row.id === args.where.id) ?? null,
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const index = state.credentials.findIndex((row) => row.id === args.where.id);
        return index < 0 ? null : state.credentials.splice(index, 1)[0];
      }),
      count: vi.fn(async () => 0),
    },
    userVoiceCredential: { count: vi.fn(async () => 0) },
    secret: {
      findFirst: vi.fn(
        async (args: { where: { id: string } }) =>
          state.secrets.find((row) => row.id === args.where.id) ?? null,
      ),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        state.secrets = state.secrets.filter((row) => row.id !== args.where.id);
        return { count: 1 };
      }),
      update: vi.fn(async () => null),
    },
  };
  let request: AgentRunRequest | undefined;
  const runtimeRun = vi.fn(async function* (next: AgentRunRequest) {
    request = next;
    yield {
      type: "usage" as const,
      provider: next.model.provider,
      model: next.model.id,
      inputTokens: 10,
      outputTokens: 5,
    };
    yield { type: "done" as const, text: "Done" };
  });
  const prisma = withModelRoles(
    {
      containerUsage: { aggregate: async () => ({ _sum: {} }) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
      usageRecord: { aggregate: async () => ({ _sum: {} }), createMany: usageCreate },
      user: { findUnique: vi.fn(async () => ({ customModelsAllowed: granted })) },
      deploymentModelChoice: {
        findMany: vi.fn(async () => [{ position: 0, enabled: true, pricing: null, ...MANAGED }]),
        count: vi.fn(async () => 1),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => run),
        findFirst: vi.fn(async () => ({
          bot: { notifyOnFinish: false },
          thread: { groupId: null },
        })),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      chatGroup: { findMany: vi.fn(async () => []) },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "bot-1",
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: OWN.provider,
          modelId: OWN.modelId,
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          computer: { id: "computer-1", scope: "dedicated" },
        })),
        findMany: vi.fn(async () => []),
      },
      attempt: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "attempt-1" })),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "thread-1",
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          nextMessageSeq: 2,
        })),
      },
      message: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
      },
      task: { findUniqueOrThrow: vi.fn(async () => ({ id: "task-1", prompt: "hello" })) },
      computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
      connection: { findMany: vi.fn(async () => []) },
      userModelPreference: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => null),
      },
      userModelCredential: {
        findMany: vi.fn(
          async ({ where }: { where: { userId?: string; provider?: ProviderFilter } }) =>
            credentialsFor(where),
        ),
        findFirst: vi.fn(async () => null),
      },
      secret: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(
          async (args: { where: { id: string } }) =>
            state.secrets.find((row) => row.id === args.where.id) ?? null,
        ),
      },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      taughtSkill: { findMany: vi.fn(async () => []) },
      vaultCredential: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      externalEffect: { findMany: vi.fn(async () => []) },
      userActionApprovalRule: { findMany: vi.fn(async () => []) },
      userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
      artifact: { findMany: vi.fn(async () => []) },
    },
    [],
  );
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const executor = createRunExecutor({
    prisma,
    billingEnabled: false,
    secretStore: {
      load: vi.fn(async (_ciphertext: string, secretId: string) => plaintexts[secretId]),
      put: vi.fn(async () => ({ ciphertext: "sealed-marker" })),
      delete: vi.fn(async () => undefined),
    },
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      listFiles: vi.fn(async () => []),
      readFile: vi.fn().mockRejectedValue(new Error("missing")),
      exportWorkspace: vi.fn(async function* () {
        yield* [];
      }),
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: { append: vi.fn(async () => undefined), finalizeRun },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun("run-1", "worker-1");
  return { request, usageCreate };
}

describe("a bot switched to the owner's own model", () => {
  it("runs on that connection, off the deployment list and the weekly allowance, once granted", async () => {
    const { request, usageCreate } = await runTurn({ granted: true });
    expect(request?.model).toMatchObject({
      provider: OWN.provider,
      id: OWN.modelId,
      apiKey: "fake-own-key",
    });
    expect(usageCreate.mock.calls[0]?.[0].data[0]).toMatchObject({ quotaExempt: true });
  });

  it("stays on the deployment list without the grant", async () => {
    const { request, usageCreate } = await runTurn({ granted: false });
    expect(request?.model).toMatchObject({ provider: MANAGED.provider, id: MANAGED.modelId });
    expect(usageCreate.mock.calls[0]?.[0].data[0]).toMatchObject({ quotaExempt: false });
  });
});
