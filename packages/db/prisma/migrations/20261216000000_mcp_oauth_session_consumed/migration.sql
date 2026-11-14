-- A second callback for the same sign-in reports the stored grant.
ALTER TABLE "mcp_oauth_sessions" ADD COLUMN "consumedAt" TIMESTAMP(3);
