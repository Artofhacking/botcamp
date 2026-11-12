import { resolveBotAvatarSet } from "@botcamp/contracts";
import { displayName, isSharedGroupRole, sharedGroupBotName } from "@botcamp/core";
import type { SharedGroupRole } from "@botcamp/core";
import { Prisma } from "./client.js";
import { activeRunStatuses } from "./thread-listing.js";

type Sql = {
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
};

type MemberRow = {
  groupId: string;
  botId: string;
  botName: string;
  color: string;
  avatarSet: string | null;
  userId: string;
  spaceId: string;
  ownerName: string | null;
};

type PersonRow = {
  groupId: string;
  userId: string;
  role: string;
  name: string;
};

export type SharedRosterMember = {
  botId: string;
  name: string;
  color: string;
  avatarSet: ReturnType<typeof resolveBotAvatarSet>;
  userId: string;
  spaceId: string;
  runs: Array<{ status: string }>;
};

export type SharedRosterPerson = {
  userId: string;
  name: string;
  role: SharedGroupRole;
};

export type SharedGroupRoster = {
  members: SharedRosterMember[];
  people: SharedRosterPerson[];
  myRole?: SharedGroupRole;
};

/**
 * Names and roles for shared groups. Callers run this as system: a guest's
 * tenant cannot see another account's bot row, and the bot row holds the name.
 */
export async function loadSharedGroupRosters(
  prisma: Sql,
  groupIds: string[],
  actorUserId: string,
): Promise<Map<string, SharedGroupRoster>> {
  const rosters = new Map<string, SharedGroupRoster>();
  if (groupIds.length === 0) return rosters;
  const memberRows = await prisma.$queryRaw<MemberRow[]>`
    SELECT m."groupId", m."botId", b.name AS "botName", b.color, b."avatarSet",
           b."userId", b."spaceId", u.name AS "ownerName"
    FROM chat_group_members m
    JOIN bots b ON b.id = m."botId"
    LEFT JOIN "user" u ON u.id = b."userId"
    WHERE m."groupId" IN (${Prisma.join(groupIds)})
      AND b."archivedAt" IS NULL
    ORDER BY m."createdAt" ASC, m."botId" ASC
  `;
  const botIds = [...new Set(memberRows.map((row) => row.botId))];
  const runRows =
    botIds.length === 0
      ? []
      : await prisma.$queryRaw<Array<{ botId: string; status: string }>>`
          SELECT "botId", status
          FROM runs
          WHERE "botId" IN (${Prisma.join(botIds)})
            AND status IN (${Prisma.join(activeRunStatuses)})
            AND trigger <> 'tickets'
        `;
  const runsByBot = new Map<string, Array<{ status: string }>>();
  for (const run of runRows) {
    const list = runsByBot.get(run.botId);
    if (list) list.push({ status: run.status });
    else runsByBot.set(run.botId, [{ status: run.status }]);
  }
  const peopleRows = await prisma.$queryRaw<PersonRow[]>`
    SELECT p."groupId", p."userId", p.role, u.name
    FROM chat_group_participants p
    JOIN "user" u ON u.id = p."userId"
    WHERE p."groupId" IN (${Prisma.join(groupIds)})
    ORDER BY p."createdAt" ASC, p."userId" ASC
  `;
  for (const groupId of groupIds) {
    rosters.set(groupId, { members: [], people: [] });
  }
  for (const row of memberRows) {
    const roster = rosters.get(row.groupId);
    if (!roster) continue;
    roster.members.push({
      botId: row.botId,
      name: sharedGroupBotName(displayName(row.ownerName, "User"), displayName(row.botName, "Bot")),
      color: row.color,
      avatarSet: resolveBotAvatarSet(row.avatarSet),
      userId: row.userId,
      spaceId: row.spaceId,
      runs: runsByBot.get(row.botId) ?? [],
    });
  }
  for (const row of peopleRows) {
    if (!isSharedGroupRole(row.role)) continue;
    const roster = rosters.get(row.groupId);
    if (!roster) continue;
    const person = {
      userId: row.userId,
      name: displayName(row.name, "User"),
      role: row.role,
    };
    roster.people.push(person);
    if (row.userId === actorUserId) roster.myRole = row.role;
  }
  return rosters;
}
