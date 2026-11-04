-- Membership plan plus its container quota. Existing rows start on free.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "weeklyCoreSecondsQuota" BIGINT NOT NULL DEFAULT 14400;
