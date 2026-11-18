import { describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_IMAGE_MODEL,
  deploymentImageChannelActive,
  deploymentModelPricing,
  INITIAL_DEPLOYMENT_MODELS,
  listDeploymentModels,
  parseDeploymentModelList,
  selectableDeploymentModels,
} from "./deployment-model-chain.js";

describe("deployment model list", () => {
  it("starts with OpenCode, then the three gateway models", () => {
    expect(INITIAL_DEPLOYMENT_MODELS.map((model) => model.provider)).toEqual([
      "opencode-go",
      "openai-compatible",
      "openai-compatible",
      "openai-compatible",
    ]);
    expect(INITIAL_DEPLOYMENT_MODELS.map((model) => model.modelId)).toEqual([
      "deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash",
      "tencent/deepseek-v4-flash",
      "openrouter/deepseek-v4.1-flash-1017",
    ]);
    expect(INITIAL_DEPLOYMENT_MODELS.map((model) => model.modelId)).not.toContain(
      DEPLOYMENT_IMAGE_MODEL.modelId,
    );
  });

  it("keeps image reading on a model outside the text failover list", () => {
    expect(DEPLOYMENT_IMAGE_MODEL).toEqual({
      provider: "openai-compatible",
      modelId: "deepseek/deepseek-v4-flash-vision-exp",
    });
  });

  it("reads images apart from the text list when an enabled row exists", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        position: 0,
        provider: "openai-compatible",
        modelId: "tencent/deepseek-v4-flash",
        enabled: true,
      },
    ]);
    const prisma = {
      deploymentModelChoice: { findMany, count: vi.fn(), createMany: vi.fn() },
    };
    await expect(
      deploymentImageChannelActive(prisma, {
        provider: "openai-compatible",
        scripted: false,
        seedWhenEmpty: false,
      }),
    ).resolves.toBe(true);
    await expect(
      deploymentImageChannelActive(prisma, {
        provider: "openrouter",
        scripted: false,
        seedWhenEmpty: false,
      }),
    ).resolves.toBe(false);
    await expect(
      deploymentImageChannelActive(prisma, {
        provider: "openai-compatible",
        scripted: true,
        seedWhenEmpty: true,
      }),
    ).resolves.toBe(false);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("treats an empty managed list as the vision channel before the run fills it", async () => {
    const prisma = {
      deploymentModelChoice: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn(),
        createMany: vi.fn(),
      },
    };
    const input = { provider: "openai-compatible" as const, scripted: false };
    await expect(
      deploymentImageChannelActive(prisma, { ...input, seedWhenEmpty: true }),
    ).resolves.toBe(true);
    await expect(
      deploymentImageChannelActive(prisma, { ...input, seedWhenEmpty: false }),
    ).resolves.toBe(false);
    await expect(
      deploymentImageChannelActive(
        { deploymentModelChoice: undefined },
        { ...input, seedWhenEmpty: true },
      ),
    ).resolves.toBe(false);
  });

  it("does not promise the vision channel when every listed model is off", async () => {
    const prisma = {
      deploymentModelChoice: {
        findMany: vi.fn().mockResolvedValue([
          {
            position: 0,
            provider: "openai-compatible",
            modelId: "tencent/deepseek-v4-flash",
            enabled: false,
          },
        ]),
        count: vi.fn(),
        createMany: vi.fn(),
      },
    };
    await expect(
      deploymentImageChannelActive(prisma, {
        provider: "openai-compatible",
        scripted: false,
        seedWhenEmpty: true,
      }),
    ).resolves.toBe(false);
  });

  it("keeps enabled models in order and drops a skipped provider", () => {
    const rows = INITIAL_DEPLOYMENT_MODELS.map((model, position) => ({
      position,
      provider: model.provider,
      modelId: model.modelId,
      enabled: position !== 2,
    }));
    expect(
      selectableDeploymentModels(rows, new Set(["opencode-go"])).map((model) => model.modelId),
    ).toEqual(["deepseek/deepseek-v4.1-flash", "openrouter/deepseek-v4.1-flash-1017"]);
  });

  it("rejects a list that turns every model off", () => {
    const parsed = parseDeploymentModelList([
      { provider: "opencode-go", modelId: "deepseek-v4.1-flash", enabled: false },
    ]);
    expect(parsed).toEqual({ ok: false, error: "enable at least one model" });
  });

  it("rewrites positions from the submitted order", () => {
    const parsed = parseDeploymentModelList([
      { provider: "openai-compatible", modelId: "tencent/deepseek-v4-flash", enabled: true },
      { provider: "opencode-go", modelId: "deepseek-v4.1-flash", enabled: false },
    ]);
    expect(parsed).toEqual({
      ok: true,
      models: [
        {
          position: 0,
          provider: "openai-compatible",
          modelId: "tencent/deepseek-v4-flash",
          enabled: true,
        },
        { position: 1, provider: "opencode-go", modelId: "deepseek-v4.1-flash", enabled: false },
      ].map((model) => ({ ...model, pricing: null })),
    });
  });

  it("keeps a valid price per model and refuses a partial one", () => {
    const parsed = parseDeploymentModelList([
      {
        provider: "openai-compatible",
        modelId: "fixture-model",
        enabled: true,
        pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 },
      },
    ]);
    expect(parsed.ok && parsed.models[0]?.pricing).toEqual({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
    });
    expect(
      parseDeploymentModelList([
        {
          provider: "openai-compatible",
          modelId: "fixture-model",
          enabled: true,
          pricing: { inputPerMillion: 0.3, outputPerMillion: null },
        },
      ]),
    ).toEqual({ ok: false, error: "a price needs input and output rates of 0 or more" });
  });

  it("keeps a peak schedule and refuses a window that ends before it starts", () => {
    const peak = {
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
      windows: [{ days: [1, 2, 3, 4, 5], start: "01:00", end: "04:00" }],
      exceptDates: ["2027-01-01"],
    };
    const entry = (windows: unknown) => ({
      provider: "openai-compatible",
      modelId: "fixture-model",
      enabled: true,
      pricing: {
        inputPerMillion: 0.15,
        outputPerMillion: 0.6,
        cacheReadPerMillion: 0.003,
        peak: { ...peak, windows },
      },
    });
    const parsed = parseDeploymentModelList([entry(peak.windows)]);
    expect(parsed.ok && parsed.models[0]?.pricing?.peak).toEqual(peak);
    expect(
      parseDeploymentModelList([entry([{ days: [1], start: "10:00", end: "06:00" }])]).ok,
    ).toBe(false);
  });

  it("reads a saved price and treats an unreadable one as none", async () => {
    const stored = [
      {
        position: 0,
        provider: "openai-compatible",
        modelId: "priced",
        enabled: true,
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      },
      {
        position: 1,
        provider: "openai-compatible",
        modelId: "broken",
        enabled: true,
        pricing: { inputPerMillion: "x" },
      },
    ];
    const prisma = {
      deploymentModelChoice: {
        findMany: vi.fn().mockResolvedValue(stored),
        findUnique: vi.fn(
          async (args: { where: { provider_modelId: { modelId: string } } }) =>
            stored.find((row) => row.modelId === args.where.provider_modelId.modelId) ?? null,
        ),
        count: vi.fn().mockResolvedValue(stored.length),
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      secret: {} as never,
    };
    await expect(deploymentModelPricing(prisma, "openai-compatible", "priced")).resolves.toEqual({
      inputPerMillion: 1,
      outputPerMillion: 2,
    });
    await expect(
      deploymentModelPricing(prisma, "openai-compatible", "broken"),
    ).resolves.toBeUndefined();
    await expect(
      deploymentModelPricing(prisma, "openai-compatible", "missing"),
    ).resolves.toBeUndefined();
    expect((await listDeploymentModels(prisma)).map((model) => model.pricing)).toEqual([
      { inputPerMillion: 1, outputPerMillion: 2 },
      null,
    ]);
  });
});
