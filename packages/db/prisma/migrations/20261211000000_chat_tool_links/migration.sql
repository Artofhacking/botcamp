-- Additive: older releases never read or write these tables.
CREATE TABLE "chat_tool_links" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "syncCursor" TEXT NOT NULL DEFAULT '',
    "pollOwner" TEXT,
    "pollUntil" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_tool_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_tool_logins" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_tool_logins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_tool_links_botId_key" ON "chat_tool_links"("botId");
CREATE UNIQUE INDEX "chat_tool_links_provider_accountId_key" ON "chat_tool_links"("provider", "accountId");
CREATE INDEX "chat_tool_links_userId_idx" ON "chat_tool_links"("userId");
CREATE INDEX "chat_tool_logins_userId_idx" ON "chat_tool_logins"("userId");
CREATE INDEX "chat_tool_logins_expiresAt_idx" ON "chat_tool_logins"("expiresAt");

ALTER TABLE "chat_tool_links" ADD CONSTRAINT "chat_tool_links_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_tool_links" ADD CONSTRAINT "chat_tool_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_tool_links" ADD CONSTRAINT "chat_tool_links_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_tool_logins" ADD CONSTRAINT "chat_tool_logins_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_tool_logins" ADD CONSTRAINT "chat_tool_logins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_tool_logins" ADD CONSTRAINT "chat_tool_logins_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_tool_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_tool_links_tenant ON "chat_tool_links"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY chat_tool_links_system ON "chat_tool_links"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "chat_tool_logins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_tool_logins_tenant ON "chat_tool_logins"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY chat_tool_logins_system ON "chat_tool_logins"
  USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_tool_links" TO rakazo_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_tool_logins" TO rakazo_app;
  END IF;
END $$;
