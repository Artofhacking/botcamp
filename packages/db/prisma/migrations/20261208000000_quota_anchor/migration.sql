-- 额度周期以用户实际开通（或改档）时刻为锚点，而不是固定周一零点。
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "quotaAnchorAt" TIMESTAMP(3);
UPDATE "user" SET "quotaAnchorAt" = now() WHERE "quotaAnchorAt" IS NULL;
