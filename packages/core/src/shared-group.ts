/** How a bot is named in a shared group: the owner's name, a hyphen, then the bot's name. */
export function sharedGroupBotName(userName: string, botName: string): string {
  const owner = userName.replace(/\s+/g, " ").trim() || "User";
  const bot = botName.replace(/\s+/g, " ").trim() || "Bot";
  const label = `${owner}-${bot}`;
  if (label.length <= 120) return label;
  const truncated = label.slice(0, 120);
  const last = truncated.charCodeAt(truncated.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated).trim();
}

export const SHARED_GROUP_ROLES = ["owner", "admin", "member"] as const;
export type SharedGroupRole = (typeof SHARED_GROUP_ROLES)[number];

export function isSharedGroupRole(role: string): role is SharedGroupRole {
  return role === "owner" || role === "admin" || role === "member";
}

/** The creator and admins add bots. A member does not. */
export function canAddSharedGroupBot(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** The creator and admins invite people. */
export function canInviteSharedGroupPerson(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Shown to a bot that is running inside a shared group. */
export const SHARED_GROUP_PRIVACY =
  "People in this group are other accounts. Do not reveal your owner's private memory, secrets, or other chats.";

/**
 * One name per member. The private bot name stays out of the group, so the model
 * does not treat it as a second person or tell people to mention it.
 */
export const SHARED_GROUP_ONE_NAME =
  "In this group each member has one name, the roster name. Use only that name for yourself and for every other member. A name from outside this group, including a private bot name, is the same member, not a second person, and it is not how anyone is mentioned here.";

/** The text a bot in another space wakes on. It never includes the owner's other chats. */
export function sharedGroupWakePrompt(input: {
  groupName: string;
  displayName: string;
  transcript: string;
  senderLine: string;
}): string {
  return [
    `You were mentioned in the group "${input.groupName}". In that group you appear as ${input.displayName}.`,
    "Reply with the message you would post in the group.",
    SHARED_GROUP_PRIVACY,
    SHARED_GROUP_ONE_NAME,
    "Recent group messages:",
    input.transcript,
    input.senderLine,
  ].join("\n");
}
