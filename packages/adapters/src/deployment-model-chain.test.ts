import { describe, expect, it, vi } from "vitest";
import {
  DEPLOYMENT_IMAGE_MODEL,
  deploymentImageChannelActive,
  INITIAL_DEPLOYMENT_MODELS,
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
      ],
    });
  });
});
