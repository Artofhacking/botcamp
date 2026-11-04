-- Which tier a bot's computer runs on: small (default provider) or big (burst provider).
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "computerTier" TEXT NOT NULL DEFAULT 'small';
