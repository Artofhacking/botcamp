-- Per-user grant for bots on the user's own model connection, and usage that grant leaves out
-- of the weekly allowance. Both default to false, so the previous release keeps working.
ALTER TABLE "user" ADD COLUMN "customModelsAllowed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "usage_records" ADD COLUMN "quotaExempt" BOOLEAN NOT NULL DEFAULT false;
