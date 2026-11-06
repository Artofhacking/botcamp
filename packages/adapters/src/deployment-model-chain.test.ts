import { describe, expect, it } from "vitest";
import {
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
