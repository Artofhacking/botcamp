import { describe, expect, it, vi } from "vitest";
import { alertMentionedPeople, sharedGroupMentionAlertText } from "./shared-group-mentions.js";

const mention = {
  groupId: "group-1",
  groupName: "Shared planning",
  threadId: "thread-1",
  senderName: "Ada",
  text: "@Bo should we ship it?",
  people: [
    { userId: "user-bo", name: "Bo" },
    { userId: "user-cy", name: "Cy" },
  ],
};

function fakeDeps(
  memberships: Array<{ userId: string; spaceId: string }>,
  events: Parameters<typeof alertMentionedPeople>[0]["events"] = {
    publishChatAlert: vi.fn().mockResolvedValue(undefined),
  },
) {
  const findMany = vi.fn().mockResolvedValue(memberships);
  const prisma = { spaceMember: { findMany } } as unknown as Parameters<
    typeof alertMentionedPeople
  >[0]["prisma"];
  return { deps: { prisma, events }, findMany, events };
}

describe("sharedGroupMentionAlertText", () => {
  it("names the sender and the group, and shows the message without Markdown", () => {
    expect(
      sharedGroupMentionAlertText({
        senderName: " Ada ",
        groupName: "Shared planning",
        text: "**ship** `today`",
      }),
    ).toEqual({ title: "Ada mentioned you in Shared planning", body: "ship today" });
  });

  it("says an attachment came without text", () => {
    expect(
      sharedGroupMentionAlertText({ senderName: "Ada", groupName: "Team", text: "  " }).body,
    ).toBe("Sent an attachment");
  });
});

describe("alertMentionedPeople", () => {
  it("tells each named person in every Space they could be watching", async () => {
    const { deps, findMany, events } = fakeDeps([
      { userId: "user-bo", spaceId: "space-b1" },
      { userId: "user-bo", spaceId: "space-b2" },
      { userId: "user-cy", spaceId: "space-c" },
    ]);
    await alertMentionedPeople(deps, mention);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: { in: ["user-bo", "user-cy"] } },
      select: { userId: true, spaceId: true },
      orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    });
    const publish = events.publishChatAlert;
    expect(publish).toHaveBeenCalledTimes(3);
    expect(vi.mocked(publish!).mock.calls).toEqual([
      [
        "user-bo",
        {
          kind: "mention",
          title: "Ada mentioned you in Shared planning",
          body: "@Bo should we ship it?",
          spaceId: "space-b1",
          threadId: "thread-1",
          groupId: "group-1",
        },
      ],
      [
        "user-bo",
        {
          kind: "mention",
          title: "Ada mentioned you in Shared planning",
          body: "@Bo should we ship it?",
          spaceId: "space-b2",
          threadId: "thread-1",
          groupId: "group-1",
        },
      ],
      [
        "user-cy",
        {
          kind: "mention",
          title: "Ada mentioned you in Shared planning",
          body: "@Bo should we ship it?",
          spaceId: "space-c",
          threadId: "thread-1",
          groupId: "group-1",
        },
      ],
    ]);
  });

  it("publishes nothing when the server has no alert stream", async () => {
    const { deps, findMany } = fakeDeps([{ userId: "user-bo", spaceId: "space-b1" }], {});
    await alertMentionedPeople(deps, mention);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("publishes nothing for a person who belongs to no Space", async () => {
    const { deps, events } = fakeDeps([]);
    await alertMentionedPeople(deps, {
      ...mention,
      people: [{ userId: "user-gone", name: "Gone" }],
    });
    expect(events.publishChatAlert).not.toHaveBeenCalled();
  });
});
