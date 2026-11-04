-- Per-user container core-seconds, sampled from running sandboxes.
CREATE TABLE IF NOT EXISTS "container_usage" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "coreSeconds" BIGINT NOT NULL DEFAULT 0,
  "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "container_usage_user_tier_day_key"
  ON "container_usage" ("userId", "tier", "day");
CREATE INDEX IF NOT EXISTS "container_usage_day_idx" ON "container_usage" ("day");
