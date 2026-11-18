import type { PrismaClient } from "@botcamp/db";
import { asSystem, createDb } from "@botcamp/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  deploymentModelPricing,
  listDeploymentModels,
  replaceDeploymentModels,
} from "./deployment-model-chain.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;
dbTests("deployment model pricing", () => {
  let db: ReturnType<typeof createDb>, prisma: PrismaClient;
  let saved: Awaited<ReturnType<PrismaClient["deploymentModelChoice"]["findMany"]>> = [];
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    saved = await prisma.deploymentModelChoice.findMany();
  });
  afterEach(async () => {
    await prisma.deploymentModelChoice.deleteMany();
    if (saved.length) {
      await prisma.deploymentModelChoice.createMany({
        data: saved.map((row) => ({ ...row, pricing: row.pricing ?? undefined })),
      });
    }
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("saves a price beside the order and reads it back for that model only", async () => {
    const result = await replaceDeploymentModels(prisma, [
      {
        provider: "openai-compatible",
        modelId: "fixture/priced",
        enabled: true,
        pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.03 },
      },
      { provider: "openai-compatible", modelId: "fixture/unpriced", enabled: true },
    ]);
    expect(Array.isArray(result)).toBe(true);
    await expect(
      deploymentModelPricing(prisma, "openai-compatible", "fixture/priced"),
    ).resolves.toEqual({ inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.03 });
    await expect(
      deploymentModelPricing(prisma, "openai-compatible", "fixture/unpriced"),
    ).resolves.toBeUndefined();
    expect((await listDeploymentModels(prisma)).map((row) => row.pricing)).toEqual([
      { inputPerMillion: 0.3, outputPerMillion: 1.2, cacheReadPerMillion: 0.03 },
      null,
    ]);
  });
});
