-- Hashes carried over from the previous BotCamp deployment, cleared once a user signs in.
CREATE TABLE IF NOT EXISTS "legacy_credentials" (
  "email" TEXT PRIMARY KEY,
  "pwHash" TEXT NOT NULL,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
