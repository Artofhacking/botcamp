-- Additive. The previous release ignores chat_groups.shared (default false) and
-- messages.senderUserId, and never reads the new tables. Extra policies are
-- permissive, so that release's access stays the same.

ALTER TABLE "chat_groups" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "messages" ADD COLUMN "senderUserId" TEXT;

CREATE TABLE "chat_group_participants" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_group_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shared_group_wakes" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupThreadId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mirroredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_group_wakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_group_participants_groupId_userId_key" ON "chat_group_participants"("groupId", "userId");
CREATE INDEX "chat_group_participants_userId_idx" ON "chat_group_participants"("userId");
CREATE UNIQUE INDEX "shared_group_wakes_runId_key" ON "shared_group_wakes"("runId");
CREATE INDEX "shared_group_wakes_groupId_idx" ON "shared_group_wakes"("groupId");

ALTER TABLE "chat_group_participants" ADD CONSTRAINT "chat_group_participants_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_group_participants" ADD CONSTRAINT "chat_group_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shared_group_wakes" ADD CONSTRAINT "shared_group_wakes_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SECURITY DEFINER so a policy on chat_group_participants can ask this without
-- reading the table through its own policy.
CREATE OR REPLACE FUNCTION app_shared_group_member(group_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.chat_group_participants AS p
    WHERE p."groupId" = group_id
      AND p."userId" = NULLIF(current_setting('app.user_id', true), '')
  );
$$;

REVOKE ALL ON FUNCTION app_shared_group_member(text) FROM PUBLIC;

ALTER TABLE "chat_group_participants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_group_participants_tenant ON "chat_group_participants"
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')
    OR app_shared_group_member("groupId")
  );
CREATE POLICY chat_group_participants_system ON "chat_group_participants"
  USING ((SELECT app_rls_bypass()));

-- Guests read and write the group thread without switching into the owner's space.
CREATE POLICY threads_shared_group ON "threads"
  USING (
    "groupId" IS NOT NULL
    AND app_shared_group_member("groupId")
  );

CREATE POLICY messages_shared_group ON "messages"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "messages"."threadId"
      AND t."groupId" IS NOT NULL
      AND app_shared_group_member(t."groupId")
  ));

CREATE POLICY events_shared_group ON "events"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "events"."threadId"
      AND t."groupId" IS NOT NULL
      AND t."spaceId" = "events"."spaceId"
      AND app_shared_group_member(t."groupId")
  ));

CREATE POLICY runs_shared_group ON "runs"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "runs"."threadId"
      AND t."groupId" IS NOT NULL
      AND t."spaceId" = "runs"."spaceId"
      AND app_shared_group_member(t."groupId")
  ));

CREATE POLICY tasks_shared_group ON "tasks"
  USING (EXISTS (
    SELECT 1 FROM "threads" t
    WHERE t."id" = "tasks"."threadId"
      AND t."groupId" IS NOT NULL
      AND t."spaceId" = "tasks"."spaceId"
      AND app_shared_group_member(t."groupId")
  ));

CREATE POLICY steering_messages_shared_group ON "steering_messages"
  USING (EXISTS (
    SELECT 1 FROM "messages" m
    JOIN "threads" t ON t."id" = m."threadId"
    WHERE m."id" = "steering_messages"."messageId"
      AND t."groupId" IS NOT NULL
      AND app_shared_group_member(t."groupId")
  ));

ALTER TABLE "shared_group_wakes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY shared_group_wakes_system ON "shared_group_wakes"
  USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "chat_group_participants" TO rakazo_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "shared_group_wakes" TO rakazo_app;
    GRANT EXECUTE ON FUNCTION app_shared_group_member(text) TO rakazo_app;
  END IF;
END $$;
