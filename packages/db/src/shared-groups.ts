import type { Actor, Group } from "@botcamp/contracts";
import { GROUP_MEMBER_MAX } from "@botcamp/contracts";
import { displayName } from "@botcamp/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { Prisma, type PrismaClient } from "./client.js";
import { createGroupRepos, lockReadableGroup, memberRowsInOrder } from "./groups.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { activeRunStatuses } from "./thread-listing.js";

/** A mistake the person can fix, such as an email with no account. */
export class SharedGroupInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedGroupInputError";
  }
}

const NO_ACCOUNT = "No account with that email";

function normalizeEmails(emails: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    unique.push(email);
  }
  return unique;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function createSharedGroupRepos(prisma: PrismaClient) {
  async function loadGroup(actor: Actor, groupId: string): Promise<Group> {
    const repos = createGroupRepos(prisma);
    return repos.mapGroup(await repos.getGroup(actor, groupId));
  }

  async function usersForEmails(emails: readonly string[]) {
    const unique = normalizeEmails(emails);
    if (unique.length === 0) return [];
    const users = await prisma.user.findMany({
      where: {
        OR: unique.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })),
      },
      select: { id: true, email: true },
    });
    if (users.length !== unique.length) throw new SharedGroupInputError(NO_ACCOUNT);
    return users;
  }

  async function requireShared(tx: Prisma.TransactionClient, actor: Actor, groupId: string) {
    const locked = await lockReadableGroup(tx, actor, groupId);
    if (!locked.shared) throw new IsolationError();
    return locked;
  }

  async function roleOf(tx: Prisma.TransactionClient, groupId: string, userId: string) {
    const row = await tx.chatGroupParticipant.findUnique({
      where: { groupId_userId: { groupId, userId } },
      select: { role: true },
    });
    return row?.role;
  }

  async function requireManager(tx: Prisma.TransactionClient, groupId: string, userId: string) {
    const role = await roleOf(tx, groupId, userId);
    if (role !== "owner" && role !== "admin") throw new IsolationError();
    return role;
  }

  async function cancelBots(
    tx: Prisma.TransactionClient,
    groupId: string,
    botIds: string[],
  ) {
    if (botIds.length === 0) return;
    const thread = await tx.thread.findFirst({
      where: { groupId },
      select: { id: true },
    });
    if (thread) {
      const activeRuns = await tx.run.findMany({
        where: {
          threadId: thread.id,
          botId: { in: botIds },
          status: { in: activeRunStatuses },
        },
        select: { id: true, taskId: true, userId: true, spaceId: true },
      });
      await cancelRunsInTransaction(tx, activeRuns, new Date());
    }
    await tx.chatGroupMember.deleteMany({ where: { groupId, botId: { in: botIds } } });
  }

  async function botsOwnedBy(
    tx: Prisma.TransactionClient,
    groupId: string,
    userId: string,
  ): Promise<string[]> {
    const rows = await runAsSystemInTransaction(tx, "read shared group member names", () =>
      tx.$queryRaw<Array<{ botId: string }>>`
        SELECT m."botId"
        FROM chat_group_members m
        JOIN bots b ON b.id = m."botId"
        WHERE m."groupId" = ${groupId} AND b."userId" = ${userId}
      `,
    );
    return rows.map((row) => row.botId);
  }

  return {
    async createSharedGroup(
      actor: Actor,
      input: { name: string; emails?: string[]; botIds?: string[] },
    ): Promise<Group> {
      const botIds = [...new Set(input.botIds ?? [])];
      if (botIds.length > GROUP_MEMBER_MAX) {
        throw new SharedGroupInputError(`A group can have up to ${GROUP_MEMBER_MAX} bots`);
      }
      const owned = botIds.length
        ? await prisma.bot.findMany({
            where: {
              id: { in: botIds },
              spaceId: actor.spaceId,
              userId: actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          })
        : [];
      if (owned.length !== botIds.length) throw new IsolationError();
      const invitees = await usersForEmails(input.emails ?? []);
      const groupId = await prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, {
          spaceId: actor.spaceId,
          userId: actor.userId,
        });
        const group = await tx.chatGroup.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: displayName(input.name, ""),
            shared: true,
          },
        });
        await tx.chatGroupParticipant.create({
          data: { groupId: group.id, userId: actor.userId, role: "owner" },
        });
        const others = invitees.filter((user) => user.id !== actor.userId);
        if (others.length) {
          await tx.chatGroupParticipant.createMany({
            data: others.map((user) => ({
              groupId: group.id,
              userId: user.id,
              role: "member",
            })),
          });
        }
        if (botIds.length) {
          await tx.chatGroupMember.createMany({
            data: memberRowsInOrder(group.id, botIds),
          });
        }
        await tx.thread.create({
          data: { spaceId: actor.spaceId, groupId: group.id, userId: actor.userId },
        });
        return group.id;
      });
      return loadGroup(actor, groupId);
    },

    async searchPeople(
      actor: Actor,
      input: { groupId: string; query: string },
    ): Promise<Array<{ userId: string; name: string; email: string }>> {
      const query = input.query.trim().slice(0, 80);
      if (!query) return [];
      const rows = await prisma.$transaction(async (tx) => {
        await requireShared(tx, actor, input.groupId);
        await requireManager(tx, input.groupId, actor.userId);
        const members = await tx.chatGroupParticipant.findMany({
          where: { groupId: input.groupId },
          select: { userId: true },
        });
        return tx.user.findMany({
          where: {
            id: { notIn: members.map((member) => member.userId) },
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { email: { contains: query, mode: "insensitive" } },
            ],
          },
          select: { id: true, name: true, email: true },
          orderBy: [{ name: "asc" }, { email: "asc" }],
          take: 8,
        });
      });
      return rows.map((user) => ({
        userId: user.id,
        name: displayName(user.name, user.email),
        email: user.email,
      }));
    },

    async invitePerson(actor: Actor, input: { groupId: string; email: string }): Promise<Group> {
      const [user] = await usersForEmails([input.email]);
      if (!user) throw new SharedGroupInputError(NO_ACCOUNT);
      await prisma.$transaction(async (tx) => {
        await requireShared(tx, actor, input.groupId);
        await requireManager(tx, input.groupId, actor.userId);
        if (user.id === actor.userId) return;
        const existing = await tx.chatGroupParticipant.findUnique({
          where: { groupId_userId: { groupId: input.groupId, userId: user.id } },
          select: { id: true },
        });
        if (existing) return;
        try {
          await tx.chatGroupParticipant.create({
            data: { groupId: input.groupId, userId: user.id, role: "member" },
          });
        } catch (error) {
          if (!isUniqueConflict(error)) throw error;
        }
      });
      return loadGroup(actor, input.groupId);
    },

    async setPersonRole(
      actor: Actor,
      input: { groupId: string; userId: string; role: "admin" | "member" },
    ): Promise<Group> {
      await prisma.$transaction(async (tx) => {
        const locked = await requireShared(tx, actor, input.groupId);
        if (locked.userId !== actor.userId) throw new IsolationError();
        if (input.userId === locked.userId) throw new IsolationError();
        const target = await roleOf(tx, input.groupId, input.userId);
        if (!target || target === "owner") throw new IsolationError();
        await tx.chatGroupParticipant.update({
          where: { groupId_userId: { groupId: input.groupId, userId: input.userId } },
          data: { role: input.role },
        });
      });
      return loadGroup(actor, input.groupId);
    },

    async removePerson(actor: Actor, input: { groupId: string; userId: string }): Promise<Group> {
      const leaving = input.userId === actor.userId;
      const current = leaving ? await loadGroup(actor, input.groupId) : undefined;
      await prisma.$transaction(async (tx) => {
        const locked = await requireShared(tx, actor, input.groupId);
        const role = await roleOf(tx, input.groupId, actor.userId);
        if (leaving) {
          if (role !== "admin" && role !== "member") throw new IsolationError();
        } else if (locked.userId !== actor.userId) {
          throw new IsolationError();
        }
        const target = await roleOf(tx, input.groupId, input.userId);
        if (!target || target === "owner") throw new IsolationError();
        await cancelBots(tx, input.groupId, await botsOwnedBy(tx, input.groupId, input.userId));
        await tx.chatGroupParticipant.delete({
          where: { groupId_userId: { groupId: input.groupId, userId: input.userId } },
        });
      });
      return current ?? loadGroup(actor, input.groupId);
    },

    async addBot(actor: Actor, input: { groupId: string; botId: string }): Promise<Group> {
      const bot = await prisma.bot.findFirst({
        where: {
          id: input.botId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!bot) throw new IsolationError();
      await prisma.$transaction(async (tx) => {
        await requireShared(tx, actor, input.groupId);
        await requireManager(tx, input.groupId, actor.userId);
        const already = await tx.chatGroupMember.findUnique({
          where: { groupId_botId: { groupId: input.groupId, botId: input.botId } },
          select: { id: true },
        });
        if (already) return;
        const [row] = await runAsSystemInTransaction(tx, "read shared group member names", () =>
          tx.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count
            FROM chat_group_members m
            JOIN bots b ON b.id = m."botId"
            WHERE m."groupId" = ${input.groupId} AND b."archivedAt" IS NULL
          `,
        );
        if (Number(row?.count ?? 0) >= GROUP_MEMBER_MAX) {
          throw new SharedGroupInputError(`A group can have up to ${GROUP_MEMBER_MAX} bots`);
        }
        await tx.chatGroupMember.create({
          data: { groupId: input.groupId, botId: input.botId },
        });
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: { updatedAt: new Date() },
        });
      });
      return loadGroup(actor, input.groupId);
    },

    async removeBot(actor: Actor, input: { groupId: string; botId: string }): Promise<Group> {
      await prisma.$transaction(async (tx) => {
        const locked = await requireShared(tx, actor, input.groupId);
        const role = await requireManager(tx, input.groupId, actor.userId);
        const [owner] = await runAsSystemInTransaction(tx, "read shared group member names", () =>
          tx.$queryRaw<Array<{ userId: string }>>`
            SELECT b."userId"
            FROM chat_group_members m
            JOIN bots b ON b.id = m."botId"
            WHERE m."groupId" = ${input.groupId} AND m."botId" = ${input.botId}
          `,
        );
        if (!owner) throw new IsolationError();
        const ownsBot = owner.userId === actor.userId;
        if (!ownsBot && role !== "owner" && locked.userId !== actor.userId) {
          throw new IsolationError();
        }
        await cancelBots(tx, input.groupId, [input.botId]);
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: { updatedAt: new Date() },
        });
      });
      return loadGroup(actor, input.groupId);
    },
  };
}
