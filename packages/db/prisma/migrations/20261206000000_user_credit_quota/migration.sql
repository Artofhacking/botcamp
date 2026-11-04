-- Weekly credit grant: 1 credit = ¥0.01, covering tokens and container time.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "weeklyCreditQuota" BIGINT NOT NULL DEFAULT 300;
