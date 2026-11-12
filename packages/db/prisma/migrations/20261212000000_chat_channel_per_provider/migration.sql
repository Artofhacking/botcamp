-- One personal chat channel per provider. Existing rows already satisfy that,
-- because each bot had at most one link and one identity. The new release
-- inserts a second provider, so these indexes apply on this deploy.
CREATE UNIQUE INDEX "chat_tool_links_botId_provider_key" ON "chat_tool_links"("botId", "provider");
CREATE UNIQUE INDEX "messaging_identities_botId_provider_key" ON "messaging_identities"("botId", "provider");
DROP INDEX "chat_tool_links_botId_key";
DROP INDEX "messaging_identities_botId_key";
