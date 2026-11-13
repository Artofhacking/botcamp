// @vitest-environment jsdom

import type { Bot, Group } from "@botcamp/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

vi.mock("@botcamp/ui-web", () => ({
  BotAvatar: () => <span />,
  Button: (props: ComponentProps<"button">) => <button {...props} />,
  Checkbox: (props: ComponentProps<"input">) => <input type="checkbox" {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  SectionHeading: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  ListSearchInput: ({
    query,
    setQuery,
    label,
    placeholder,
  }: {
    query: string;
    setQuery: (query: string) => void;
    label: string;
    placeholder: string;
  }) => (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  ),
}));

import { SharedGroupSettings } from "./SharedGroupPanel";

const group: Group = {
  id: "group-1",
  spaceId: "space-1",
  name: "Review",
  pinned: false,
  sectionId: null,
  archivedAt: null,
  members: [{ botId: "bot-1", name: "Mina-Helper", color: "blue" }],
  threadId: "thread-1",
  preview: "",
  unread: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  shared: true,
  myRole: "owner",
  people: [
    { userId: "owner", name: "Mina", role: "owner" },
    { userId: "bea", name: "Bea", role: "member" },
  ],
};

function fakeBot(id: string, name: string): Bot {
  return {
    id,
    spaceId: "space-1",
    name,
    title: "",
    description: "",
    instructions: "",
    color: "blue",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: `thread-${id}`,
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    fleetManagement: false,
    spawnKey: null,
    computerTier: "small",
  };
}

const bots = [fakeBot("bot-1", "Helper"), fakeBot("bot-2", "Spare")];

let container: HTMLDivElement;
let root: Root;

function groupsRpc() {
  return {
    searchPeople: vi.fn(async ({ query }: { query: string }) => ({
      people: query === "Ada" ? [{ userId: "ada", name: "Ada", email: "ada@example.com" }] : [],
    })),
    invite: vi.fn(async () => group),
    setPersonRole: vi.fn(async () => group),
    removePerson: vi.fn(async () => group),
    addBot: vi.fn(async () => group),
    removeBot: vi.fn(async () => group),
    update: vi.fn(async () => group),
  };
}

async function render(
  options: { group?: Group; userId?: string; rpc?: ReturnType<typeof groupsRpc> } = {},
) {
  const groups = options.rpc ?? groupsRpc();
  await act(async () => {
    root.render(
      <SharedGroupSettings
        rpc={{ groups } as unknown as ComponentProps<typeof SharedGroupSettings>["rpc"]}
        group={options.group ?? group}
        bots={bots}
        userId={options.userId}
        onGroup={() => undefined}
        onLeft={() => undefined}
        onRemove={async () => undefined}
        onClose={() => undefined}
      />,
    );
  });
  return { rpc: { groups } };
}

function field(label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing ${label} field`);
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonIncluding(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing ${text} button`);
  return found;
}

async function click(control: HTMLElement) {
  await act(async () => {
    control.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SharedGroupSettings", () => {
  it("lists people and bots already in the group, and searches to add one you own", async () => {
    const { rpc } = await render();

    expect(container.textContent).toContain("Mina");
    expect(container.textContent).toContain("Bea");
    expect(container.textContent).toContain("Mina-Helper");
    expect(container.textContent).not.toContain("Spare");

    await typeInto(field("Your bots"), "spa");
    expect(container.textContent).toContain("Spare");
    await click(buttonIncluding("Spare"));
    expect(rpc.groups.addBot).toHaveBeenCalledWith({ groupId: "group-1", botId: "bot-2" });
  });

  it("searches for an account to invite, and still accepts a full email", async () => {
    vi.useFakeTimers();
    const { rpc } = await render();

    await typeInto(field("People"), "Ada");
    expect(rpc.groups.searchPeople).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(rpc.groups.searchPeople).toHaveBeenCalledWith({ groupId: "group-1", query: "Ada" });
    expect(container.textContent).toContain("ada@example.com");
    await click(buttonIncluding("ada@example.com"));
    expect(rpc.groups.invite).toHaveBeenCalledWith({
      groupId: "group-1",
      email: "ada@example.com",
    });

    await typeInto(field("People"), "guest@example.com");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await click(buttonIncluding("guest@example.com"));
    expect(rpc.groups.invite).toHaveBeenCalledWith({
      groupId: "group-1",
      email: "guest@example.com",
    });
  });

  it("lets the owner switch a person between member and admin", async () => {
    const { rpc } = await render();
    const admin = container.querySelector<HTMLInputElement>(
      'fieldset[aria-label="Bea"] input[value="admin"]',
    );
    if (!admin) throw new Error("Missing Admin");
    expect(admin.checked).toBe(false);
    await click(admin);
    expect(rpc.groups.setPersonRole).toHaveBeenCalledWith({
      groupId: "group-1",
      userId: "bea",
      role: "admin",
    });
  });

  it("hides search and role editing from a member", async () => {
    await render({ group: { ...group, myRole: "member" }, userId: "bea" });

    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("fieldset")).toBeNull();
    expect(container.textContent).toContain("Mina-Helper");
    expect(container.textContent).not.toContain("Spare");
    expect(container.textContent).toContain("Leave");
  });
});
