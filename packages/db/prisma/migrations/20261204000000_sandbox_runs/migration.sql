-- Live sandbox state, written by the sampler so the console only reads the database.
CREATE TABLE IF NOT EXISTS "sandbox_runs" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL,
  "userId" TEXT,
  "tier" TEXT NOT NULL,
  "cores" DOUBLE PRECISION NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "coreSeconds" BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "sandbox_runs_ended_at_idx" ON "sandbox_runs" ("endedAt");
CREATE INDEX IF NOT EXISTS "sandbox_runs_started_at_idx" ON "sandbox_runs" ("startedAt");
