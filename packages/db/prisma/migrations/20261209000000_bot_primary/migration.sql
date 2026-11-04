-- 每个用户最早创建的 bot 成为主 bot，负责管理其余的 bot。
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT false;

WITH first_bot AS (
  SELECT DISTINCT ON ("userId") id
  FROM "bots"
  ORDER BY "userId", "createdAt" ASC
)
UPDATE "bots" SET "isPrimary" = true WHERE id IN (SELECT id FROM first_bot);

CREATE UNIQUE INDEX IF NOT EXISTS "bots_one_primary_per_user"
  ON "bots" ("userId") WHERE "isPrimary";
