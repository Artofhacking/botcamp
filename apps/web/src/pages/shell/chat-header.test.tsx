// @vitest-environment jsdom

import type { BillingStatus, Bot, Group, ThreadSnapshot } from "@botcamp/contracts";
import { BOT_COLORS } from "@botcamp/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const billing = vi.hoisted(() => ({ status: null as Partial<BillingStatus> | null }));
const writeText = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@botcamp/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    BotAvatar: ({ identity }: { identity?: string }) => <i data-bot-avatar={identity} />,
    Input: (props: Record<string, unknown>) => <input {...props} />,
    GroupAvatar: ({ members }: { members?: { botId?: string }[] }) => (
      <i data-group-avatars={members?.map((member) => member.botId).join(" ")} />
    ),
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
  };
});
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: billing.status, showPlans: () => undefined }),
}));

import { ChatHeader } from "./chat-header";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  billing.status = null;
  writeText.mockClear();
});

function renderHeader({ inGroup = false } = {}) {
  act(() =>
    root.render(
      <ChatHeader
        inGroup={inGroup}
        active={
          inGroup ? undefined : ({ id: "bot-1", name: "Helper", color: BOT_COLORS[0] } as Bot)
        }
        activeGroup={undefined}
        activeSnapshot={null}
        phoneCallsEnabled={false}
        voiceReady={false}
        inCall={false}
        panelOpen={false}
        onOpenNavigation={() => undefined}
        onTogglePanel={() => undefined}
        onCall={() => undefined}
      />,
    ),
  );
}

const gift = () => container.querySelector<HTMLButtonElement>('[aria-label="Invite a friend"]');

function renderGroupHeader(group: Group, snapshot: ThreadSnapshot | null = null) {
  act(() =>
    root.render(
      <ChatHeader
        inGroup
        active={undefined}
        activeGroup={group}
        activeSnapshot={snapshot}
        phoneCallsEnabled={false}
        voiceReady={false}
        inCall={false}
        panelOpen={false}
        onOpenNavigation={() => undefined}
        onTogglePanel={() => undefined}
        onCall={() => undefined}
      />,
    ),
  );
}

it("shows no gift when the account cannot invite", () => {
  billing.status = { referral: null };
  renderHeader();
  expect(gift()).toBeNull();
});

it("shows the gift only in a bot chat, as mobile does", () => {
  billing.status = { referral: { url: "https://example.test/sign-up?ref=abc", rewards: 0 } };
  renderHeader({ inGroup: true });
  expect(gift()).toBeNull();
});

it("opens the invite with both rewards and copies the link", async () => {
  billing.status = { referral: { url: "https://example.test/sign-up?ref=abc", rewards: 2 } };
  renderHeader();
  act(() => gift()!.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Give a friend 2 weeks free");
  expect(dialog.textContent).toContain("They get 2 weeks free.");
  expect(dialog.textContent).toContain(
    "You get a free month when they start their trial with a new card.",
  );
  // The link is also shown, so it can be copied by hand.
  expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')?.value).toBe(
    "https://example.test/sign-up?ref=abc",
  );
  expect(dialog.textContent).toContain("2 free months earned");
  const copy = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy link",
  )!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith("https://example.test/sign-up?ref=abc");
  expect(dialog.textContent).toContain("Copied");
});

it("lists every shared-group bot by its in-group name", () => {
  renderGroupHeader(
    {
      id: "group-1",
      name: "Standup",
      shared: true,
      members: [
        { botId: "mine", name: "Ada-Helper", color: BOT_COLORS[0] },
        { botId: "theirs", name: "Bea-Scout", color: BOT_COLORS[1] },
      ],
    } as Group,
    {
      threadId: "thread-1",
      cursor: 1,
      messages: [],
      olderCursor: null,
      groupId: "group-1",
      members: [{ botId: "mine", name: "Mine-short", color: BOT_COLORS[0] }],
      run: null,
    } as ThreadSnapshot,
  );
  expect(container.textContent).toContain("Standup");
  expect(container.textContent).toContain("Shared");
  expect(container.querySelector("[data-shared-mark]")?.textContent).toBe("Shared");
  expect(container.textContent).toContain("Ada-Helper");
  expect(container.textContent).toContain("Bea-Scout");
  expect(container.textContent).not.toContain("Mine-short");
  expect(container.querySelector("[data-group-avatars]")?.getAttribute("data-group-avatars")).toBe(
    "mine theirs",
  );
  expect(
    [...container.querySelectorAll("[data-bot-avatar]")].map((node) =>
      node.getAttribute("data-bot-avatar"),
    ),
  ).toEqual(["mine", "theirs"]);
});

it("keeps a private group header to the group name", () => {
  renderGroupHeader({
    id: "group-1",
    name: "Notes",
    members: [
      { botId: "a", name: "Ada-Helper", color: BOT_COLORS[0] },
      { botId: "b", name: "Bea-Scout", color: BOT_COLORS[1] },
    ],
  } as Group);
  expect(container.textContent).toContain("Notes");
  expect(container.textContent).not.toContain("Ada-Helper");
  expect(container.querySelector("[data-shared-mark]")).toBeNull();
});
