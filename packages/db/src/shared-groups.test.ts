import type { Actor } from "@botcamp/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";
import { createSharedGroupRepos } from "./shared-groups.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "owner",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

function client(role: string) {
  const tx = {
    $queryRaw: vi.fn(async () => [
      { id: "group-1", spaceId: "space-1", userId: "owner", shared: true },
    ]),
    chatGroupParticipant: {
      findUnique: vi.fn(async () => ({ role })),
      findMany: vi.fn(async () => [{ userId: "owner" }, { userId: "member-1" }]),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: "ada", name: "Ada", email: "ada@example.com" },
        { id: "blank", name: "   ", email: "blank@example.com" },
      ]),
    },
  };
  return {
    tx,
    prisma: {
      $transaction: async (fn: (inner: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaClient,
  };
}

describe("searchPeople", () => {
  it("finds accounts that are not already in the group", async () => {
    const { prisma, tx } = client("owner");
    const people = await createSharedGroupRepos(prisma).searchPeople(actor, {
      groupId: "group-1",
      query: "  Ada  ",
    });

    expect(people).toEqual([
      { userId: "ada", name: "Ada", email: "ada@example.com" },
      { userId: "blank", name: "blank@example.com", email: "blank@example.com" },
    ]);
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { notIn: ["owner", "member-1"] },
          OR: [
            { name: { contains: "Ada", mode: "insensitive" } },
            { email: { contains: "Ada", mode: "insensitive" } },
          ],
        },
        take: 8,
      }),
    );
  });

  it("refuses a member who cannot invite", async () => {
    const { prisma, tx } = client("member");
    await expect(
      createSharedGroupRepos(prisma).searchPeople(actor, { groupId: "group-1", query: "Ada" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(tx.user.findMany).not.toHaveBeenCalled();
  });
});
