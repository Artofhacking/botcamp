import { groupBotsForSidebar } from "@rakazo/core";

type SidebarChat = {
  id: string;
  name: string;
  preview?: string | null;
  pinned: boolean;
  sectionId: string | null;
};

type SidebarSpace<TBot extends SidebarChat, TGroup extends SidebarChat> = {
  id: string;
  name: string;
  canRename?: boolean;
  canDelete?: boolean;
  bots: readonly TBot[];
  groups: readonly TGroup[];
  botSections: readonly { id: string; name: string }[];
};

/** Spaces are not a product surface: no name, lock, or settings menu in the roster. */
function spaceHeaderMenu() {
  return {
    canRenameSpace: false,
    canDeleteSpace: false,
    canOpenSpaceSettings: false,
  };
}

export async function commitSpaceRename(input: {
  rename: () => Promise<void>;
  apply: () => void;
  refresh: () => Promise<void>;
}): Promise<void> {
  await input.rename();
  input.apply();
  await input.refresh().catch(() => undefined);
}

export function sidebarGroupsForSpaces<TBot extends SidebarChat, TGroup extends SidebarChat>(
  spaces: readonly SidebarSpace<TBot, TGroup>[],
  query: string,
  labels?: { pinned: string; unassigned: string },
) {
  const needle = query.toLowerCase();
  // More than one membership still lists its chats, without naming them as spaces.
  const separate = spaces.length > 1;
  return spaces.flatMap((space) => {
    const visibleBots = space.bots.filter((bot) =>
      `${bot.name} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
    );
    const visibleGroups = space.groups.filter((group) =>
      `${group.name} ${group.preview ?? ""}`.toLowerCase().includes(needle),
    );
    const grouped = groupBotsForSidebar(
      [
        ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
        ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
      ].map((item) => ({
        ...item,
        id: item.chat.id,
        pinned: item.chat.pinned,
        sectionId: item.chat.sectionId,
      })),
      space.botSections,
      { labels },
    );
    // Keep destinations visible after their last bot is dragged out. Search
    // still hides empty lists, and spaces without sections keep their old layout.
    if (!needle && space.botSections.length > 0 && grouped.length > 0) {
      for (const section of space.botSections) {
        const key = `section:${section.id}`;
        if (!grouped.some((group) => group.key === key)) {
          grouped.push({ key, title: section.name, bots: [] });
        }
      }
      if (!grouped.some((group) => group.key === "unassigned")) {
        grouped.push({ key: "unassigned", title: labels?.unassigned ?? "Unassigned", bots: [] });
      }
      const order = [
        "pinned",
        ...space.botSections.map((section) => `section:${section.id}`),
        "unassigned",
      ];
      grouped.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    const sections = grouped.map((group) => ({
      ...group,
      sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
      key: separate ? `space:${space.id}:${group.key}` : group.key,
      title: group.title,
      subtitle: undefined,
      showLock: false,
      emptySpaceId: undefined as string | undefined,
      spaceId: space.id,
      spaceName: space.name,
      ...spaceHeaderMenu(),
    }));
    if (sections.length > 0) return sections;
    if (needle) return [];
    // Saved sections stay listed so they can still be renamed or deleted
    // after their last chat leaves. An empty workspace has no header of its own.
    return space.botSections.map((section) => ({
      key: separate ? `space:${space.id}:section:${section.id}` : `section:${section.id}`,
      title: section.name,
      subtitle: undefined,
      bots: [] as (typeof sections)[number]["bots"],
      sectionId: section.id as string | null,
      showLock: false,
      emptySpaceId: undefined as string | undefined,
      spaceId: space.id,
      spaceName: space.name,
      ...spaceHeaderMenu(),
    }));
  });
}

/** Count the unread flags the roster renders. Pass unfiltered groups for the app badge. */
export function countUnreadChats(
  sections: readonly { bots: readonly { chat: { unread?: boolean } }[] }[],
): number {
  return sections.reduce(
    (count, section) => count + section.bots.filter((item) => item.chat.unread).length,
    0,
  );
}
