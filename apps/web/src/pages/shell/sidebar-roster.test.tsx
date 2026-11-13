// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sidebarGroupsForSpaces } from "./space-sidebar";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@botcamp/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    BotAvatar: ({ identity }: { identity?: string }) => <i data-bot-avatar={identity} />,
    Button: Plain,
    Collapsible: Plain,
    CollapsibleContent: Plain,
    CollapsibleTrigger: Plain,
    ContextMenu: Plain,
    ContextMenuContent: Plain,
    ContextMenuItem: Plain,
    ContextMenuTrigger: ({
      children,
      render: _render,
      ...props
    }: { children?: ReactNode; render?: unknown } & Record<string, unknown>) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    GroupAvatar: ({ members }: { members?: { botId?: string }[] }) => (
      <i data-group-avatars={members?.map((member) => member.botId).join(" ")} />
    ),
  };
});

import { SidebarRoster } from "./sidebar-roster";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderRoster(shared: boolean) {
  const groups = sidebarGroupsForSpaces(
    [
      {
        id: "space-1",
        name: "Space",
        bots: [],
        botSections: [],
        groups: [
          {
            id: "group-1",
            spaceId: "space-1",
            name: "Standup",
            pinned: false,
            sectionId: null,
            preview: "hello",
            unread: false,
            updatedAt: "2026-08-20T00:00:00.000Z",
            ...(shared ? { shared: true } : {}),
            members: [
              { botId: "mine", name: "Ada-Helper", color: "#111111" },
              { botId: "theirs", name: "Bea-Scout", color: "#222222" },
            ],
          },
        ],
      },
    ],
    "",
  );
  act(() =>
    root.render(
      <SidebarRoster
        sidebarGroups={groups}
        collapsedSidebarSections={new Set()}
        bootstrapMe={{ spaceId: "space-1" }}
        botSections={[]}
        spaces={[]}
        rosterDropKey={null}
        setRosterDropKey={() => undefined}
        rosterDropAction={() => null}
        applyRosterDrop={() => undefined}
        openSpaceChat={() => undefined}
        spaceMenuAnchor={{ current: null }}
        setSpaceMenu={() => undefined}
        setRenameSectionTarget={() => undefined}
        setDeleteSectionTarget={() => undefined}
        toggleSidebarSection={() => undefined}
        inGroup={false}
        active={undefined}
        activeGroup={undefined}
        botsSidebarDensity="comfortable"
        dismissedRunErrorIds={new Set()}
        displayedRunError={null}
        draggedBotId={null}
        setDraggedBotId={() => undefined}
        botMenu={null}
        setBotMenu={() => undefined}
        reorderRosterBot={() => undefined}
        activeSnapshot={null}
        botMenuContent={null}
      />,
    ),
  );
}

it("marks a shared group and still shows its latest message", () => {
  renderRoster(true);
  expect(container.querySelector("[data-shared-mark]")?.textContent).toBe("Shared");
  expect(container.querySelector("[data-roster-preview]")?.textContent).toBe("hello");
  expect(container.querySelector("[data-roster-members]")).toBeNull();
  expect(container.textContent).not.toContain("Ada-Helper");
});

it("leaves a private group unmarked and shows its latest message", () => {
  renderRoster(false);
  expect(container.querySelector("[data-shared-mark]")).toBeNull();
  expect(container.querySelector("[data-roster-preview]")?.textContent).toBe("hello");
  expect(container.textContent).toContain("Standup");
});
