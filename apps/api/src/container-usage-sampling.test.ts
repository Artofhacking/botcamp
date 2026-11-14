import { describe, expect, it } from "vitest";
import {
  coresFromContainerLimits,
  dockerSamplesFromInspect,
  imageTier,
} from "./container-usage-sampling.js";

describe("coresFromContainerLimits", () => {
  it("prefers the nano CPU limit", () => {
    expect(coresFromContainerLimits({ NanoCpus: 2_000_000_000 })).toBe(2);
  });

  it("falls back to quota over period", () => {
    expect(coresFromContainerLimits({ CpuQuota: 50_000, CpuPeriod: 100_000 })).toBe(0.5);
  });

  it("counts an unlimited computer as one core", () => {
    expect(coresFromContainerLimits({})).toBe(1);
    expect(coresFromContainerLimits(undefined)).toBe(1);
  });
});

describe("dockerSamplesFromInspect", () => {
  const running = {
    Id: "abc",
    Name: "/botcamp-bot-cm1",
    Config: { Image: "botcamp/computer:1", Labels: { "botcamp.botId": "cm1" } },
    HostConfig: { NanoCpus: 1_000_000_000 },
    State: { Running: true, StartedAt: "2026-11-14T00:00:00Z" },
  };

  it("reads a running bot computer", () => {
    expect(dockerSamplesFromInspect([running])).toEqual([
      {
        botId: "cm1",
        tier: "desktop",
        cores: 1,
        podName: "botcamp-bot-cm1",
        startedAt: "2026-11-14T00:00:00Z",
      },
    ]);
  });

  it("skips stopped containers and containers that are not bot computers", () => {
    const stopped = { ...running, State: { Running: false } };
    const other = {
      ...running,
      Config: { Image: "registry:2", Labels: {} },
    };
    expect(dockerSamplesFromInspect([stopped, other])).toEqual([]);
  });

  it("accepts the legacy label", () => {
    const legacy = {
      ...running,
      Config: { Image: "botcamp/computer:1", Labels: { "rakazo-bot-id": "old" } },
    };
    expect(dockerSamplesFromInspect([legacy])[0]?.botId).toBe("old");
  });
});

describe("imageTier", () => {
  it("separates burst and desktop images", () => {
    expect(imageTier("botcamp/computer:1")).toBe("desktop");
    expect(imageTier("botcamp/sandbox:1")).toBe("big");
    expect(imageTier(undefined)).toBe("big");
  });
});
