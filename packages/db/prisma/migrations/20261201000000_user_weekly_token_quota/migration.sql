-- Weekly model-token allowance per user, and the index the allowance check reads.
ALTER TABLE "user" ADD COLUMN "weeklyTokenQuota" BIGINT NOT NULL DEFAULT 50000000;

CREATE INDEX "usage_records_user_created_idx" ON "usage_records" ("userId", "createdAt");
