import type { ChatAlert } from "@botcamp/contracts";
import { plainTextFromMarkdown, truncatePlainText } from "@botcamp/core";
import type { PrismaClient, ThreadEvents } from "@botcamp/db";

const MENTION_ALERT_MAX_CHARS = 180;

/** One participant a shared-group message names, with the name the group shows for them. */
export type MentionedPerson = { userId: string; name: string };

export type SharedGroupMention = {
  groupId: string;
  groupName: string;
  threadId: string;
  senderName: string;
  /** The sent message, so the alert carries its words rather than a generic notice. */
  text: string;
  people: readonly MentionedPerson[];
};

/** The words a mention alert shows. */
export function sharedGroupMentionAlertText(input: {
  senderName: string;
  groupName: string;
  text: string;
}): { title: string; body: string } {
  const sender = input.senderName.trim() || "Someone";
  const group = input.groupName.trim();
  const title = truncatePlainText(
    group ? `${sender} mentioned you in ${group}` : `${sender} mentioned you`,
    MENTION_ALERT_MAX_CHARS,
  );
  const body = input.text.trim()
    ? truncatePlainText(plainTextFromMarkdown(input.text), MENTION_ALERT_MAX_CHARS)
    : "Sent an attachment";
  return { title, body };
}

/**
 * Tells each named person that a shared-group message mentions them. A guest reads the
 * group without joining its Space, so the alert goes to every Space they belong to and
 * reaches whichever one their open app is watching. Transient, like every chat alert.
 */
export async function alertMentionedPeople(
  deps: {
    prisma: Pick<PrismaClient, "spaceMember">;
    events: Pick<ThreadEvents, "publishChatAlert">;
  },
  mention: SharedGroupMention,
): Promise<void> {
  const publish = deps.events.publishChatAlert;
  const userIds = [...new Set(mention.people.map((person) => person.userId))];
  if (!publish || userIds.length === 0) return;
  const memberships = await deps.prisma.spaceMember.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, spaceId: true },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
  });
  if (memberships.length === 0) return;
  const { title, body } = sharedGroupMentionAlertText(mention);
  await Promise.all(
    memberships.map((membership) => {
      const alert: ChatAlert = {
        kind: "mention",
        title,
        body,
        spaceId: membership.spaceId,
        threadId: mention.threadId,
        groupId: mention.groupId,
      };
      return publish(membership.userId, alert);
    }),
  );
}
