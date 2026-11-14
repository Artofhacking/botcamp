// @vitest-environment jsdom

import type { Bot, BotAvatarSet } from "@botcamp/contracts";
import { i18n } from "@lingui/core";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => {
  const rpc = {
    bots: { get: vi.fn(), update: vi.fn(), restoreInstructions: vi.fn() },
    voice: { voices: vi.fn().mockResolvedValue([]) },
    models: {
      credentials: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    },
    me: vi.fn().mockResolvedValue(null),
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@botcamp/ui-web", () => ({
  SectionHeading: ({
    variant: _variant,
    ...props
  }: ComponentProps<"h3"> & { variant?: string }) => <h3 {...props} />,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    onCheckedChange,
    checked,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Toggle: ({
    onPressedChange: _onPressedChange,
    pressed,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => (
    <button type="button" aria-pressed={pressed} {...props}>
      {props.children}
    </button>
  ),
  Tabs: ({
    value: _value,
    onValueChange: _onValueChange,
    ...props
  }: ComponentProps<"div"> & { value?: string; onValueChange?: (value: string) => void }) => (
    <div {...props} />
  ),
  TabsList: (props: ComponentProps<"div">) => <div role="tablist" {...props} />,
  TabsTrigger: ({ value: _value, ...props }: ComponentProps<"button"> & { value: string }) => (
    <button type="button" role="tab" {...props} />
  ),
  TabsContent: ({ value: _value, ...props }: ComponentProps<"div"> & { value: string }) => (
    <div {...props} />
  ),
}));
vi.mock("./avatar-studio-popover", () => ({
  AvatarStudioPopover: ({
    value,
    avatarSet,
    onChange,
  }: {
    value: string;
    avatarSet?: BotAvatarSet;
    onChange: (value: string, avatarSet?: BotAvatarSet) => void;
  }) => (
    <>
      <button
        type="button"
        aria-label="Avatar color"
        data-color={value}
        onClick={() => onChange(value === "blue" ? "ink" : "blue")}
      />
      <button
        type="button"
        aria-label="Avatar set"
        data-avatar-set={avatarSet}
        data-color={value}
        onClick={() => onChange("#F97316", avatarSet === "rakazo" ? "organic" : "rakazo")}
      />
    </>
  ),
}));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => <h3>Open work</h3> }));
vi.mock("../KnowledgeSection", () => ({
  KnowledgeSection: () => <h3>Memory and skills</h3>,
}));

import { InstructionSettings } from "../../components/InstructionSettings";
import { spaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const longInstructions = "I".repeat(4_000);

function bot(description = "Billing", overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Ada",
    title: "Helper",
    description,
    instructions: longInstructions,
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    runErrorId: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    fleetManagement: false,
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
    ...overrides,
    computerTier: overrides.computerTier ?? "small",
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const onSave = vi.fn(
  async (_patch: Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0]) => undefined,
);
const onExport = vi.fn(async () => undefined);

async function render(
  description = "Billing",
  overrides: Partial<Bot> = {},
  memoryProviderConfigured = false,
  focusModel = 0,
) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotSettings
          onOpenConnections={() => undefined}
          focusModel={focusModel}
          bot={bot(description, overrides)}
          memoryProviderConfigured={memoryProviderConfigured}
          onSave={onSave}
          onExport={onExport}
          onClear={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function descriptionField(): HTMLTextAreaElement {
  const textarea =
    container.querySelector<HTMLTextAreaElement>('textarea[id$="-description"]') ??
    container.querySelector("textarea");
  if (!textarea) throw new Error("Missing description field");
  return textarea;
}

async function setDescription(value: string) {
  const textarea = descriptionField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSave() {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Save",
  );
  await act(async () => {
    if (button) button.click();
    else container.querySelector<HTMLButtonElement>('button[id$="-notify-finish"]')!.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  onExport.mockReset().mockResolvedValue(undefined);
  vi.mocked(rpc.bots.update).mockReset();
  vi.mocked(rpc.bots.get).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the profile and the Advanced tab's controls", async () => {
  vi.mocked(rpc.voice.voices).mockResolvedValueOnce([
    { id: "fixture-voice", label: "Fixture voice" },
  ]);
  await render("Billing", {}, true);
  expect(container.querySelector('[data-testid="bot-profile-header"]')?.textContent).toContain(
    "Ada",
  );
  expect(container.querySelector('input[aria-label="Name"]')).toBeNull();
  expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Computer",
    "Routines",
    "Pages",
    "Advanced",
  ]);
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Save"),
  ).toBe(false);
  const advanced = container.querySelector<HTMLElement>('[data-testid="bot-settings-advanced"]')!;
  expect(advanced.querySelector('textarea[id$="-instructions"]')).not.toBeNull();
  expect(advanced.textContent).toContain("When it finishes or needs input");
  expect(advanced.textContent).toContain("Daily check-ins on unfinished work");
  expect(advanced.textContent).toContain("Allow cross-space bot communication");
  expect(advanced.textContent).toContain("主 bot");
});

describe("BotSettings thinking options", () => {
  it("preserves saved thinking on a profile save when options are hidden", async () => {
    await render("Billing", {
      modelProvider: "openai-compatible",
      modelId: "beta",
      thinkingLevel: "high",
    });
    await clickSave();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("thinkingLevel");
  });
});

describe("BotSettings bot management saves", () => {
  it("cannot restore a stale enabled value when another session disables it", async () => {
    await render("Billing", { fleetManagement: true });
    await render("Billing", { fleetManagement: false });
    await clickSave();
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("fleetManagement");
  });

  it("shows a failed export instead of leaving it unhandled", async () => {
    await render();
    onExport.mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { status: 502 }));
    const exportButton = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Export",
    );
    if (!exportButton) throw new Error("Missing export");
    await act(async () => {
      exportButton.click();
    });
    expect(container.textContent).toContain("Could not reach the server");
  });
});

describe("BotSettings description saves", () => {
  it("leaves instructions off a save that does not edit the description", async () => {
    await render();
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("does not resend instructions when the bot prop stays on the old description", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");

    // The parent still passes the description from when the panel opened.
    await render();
    await clickSave();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("still saves a description edited back to the stale prop value", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    await render();
    await setDescription("Billing");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Billing",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");
  });

  it("keeps the previous description as the baseline when a save fails", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setDescription("Invoices");
    await clickSave();
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("instructions");
  });
});

describe("instruction settings refresh", () => {
  it("refreshes a saved field against its latest baseline before the parent catches up", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Saved edit" });
    await act(async () => {
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Saved edit");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await act(async () => {
      root.render(<InstructionSettings bot={{ ...initial, instructions: "External update" }} />);
    });
    expect(descriptionField().value).toBe("External update");
    await setDescription("Fresh edit");
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Fresh edit" });
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenLastCalledWith({
      botId: initial.id,
      instructions: "Fresh edit",
      expectedInstructions: "External update",
    });
  });
  it("keeps a dirty draft when run completion refreshes the bot", async () => {
    const initial = bot();
    await act(async () => {
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      root.render(
        <InstructionSettings bot={{ ...initial, updatedAt: "2026-09-02T00:00:00.000Z" }} />,
      );
    });
    expect(descriptionField().value).toBe("Unsaved instructions");
  });
  it("saves the original draft baseline after a newer instruction refresh", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({
      ...initial,
      instructions: "Unsaved instructions",
    });
    await act(async () => {
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      root.render(
        <InstructionSettings bot={{ ...initial, instructions: "Newer saved instructions" }} />,
      );
    });
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenCalledWith({
      botId: initial.id,
      instructions: "Unsaved instructions",
      expectedInstructions: initial.instructions,
    });
  });
  it("reloads the current instructions and baseline after a conflict", async () => {
    const initial = bot();
    vi.mocked(rpc.bots.update).mockRejectedValueOnce(
      new ORPCError("CONFLICT", { message: "Instructions changed" }),
    );
    vi.mocked(rpc.bots.get)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ...initial,
        instructions: "Newer saved instructions",
      });
    await act(async () => {
      root.render(<InstructionSettings bot={initial} />);
    });
    await setDescription("Unsaved instructions");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const reload = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload",
    );
    if (!reload) throw new Error("Missing reload action");
    expect(descriptionField().value).toBe("Unsaved instructions");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      reload.click();
    });
    expect(descriptionField().value).toBe("Unsaved instructions");
    expect(container.textContent).toContain("Reload");
    await act(async () => {
      reload.click();
    });
    expect(descriptionField().value).toBe("Newer saved instructions");
    vi.mocked(rpc.bots.update).mockResolvedValueOnce({ ...initial, instructions: "Fresh draft" });
    await setDescription("Fresh draft");
    await act(async () => {
      descriptionField().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(rpc.bots.update).toHaveBeenLastCalledWith({
      botId: initial.id,
      instructions: "Fresh draft",
      expectedInstructions: "Newer saved instructions",
    });
  });
  it("refreshes pristine instructions after an external update", async () => {
    const initial = bot();
    await act(async () => {
      root.render(<InstructionSettings bot={initial} />);
    });
    await act(async () => {
      root.render(
        <InstructionSettings bot={{ ...initial, instructions: "Approved replacement" }} />,
      );
    });
    expect(descriptionField().value).toBe("Approved replacement");
  });
});

it("cancels an inline name edit", async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
  );
  const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  expect(input.value).toBe("Ada");
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(container.querySelector('[aria-label="Name"]')).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
});

it("saves inline name edits on blur and on Enter", async () => {
  await render();
  for (const [value, event] of [
    ["Atlas", new FocusEvent("focusout", { bubbles: true })],
    ["Ada", new KeyboardEvent("keydown", { key: "Enter", bubbles: true })],
  ] as const) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(event));
    expect(onSave.mock.lastCall?.[0]).toHaveProperty("name", value);
  }
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "keeps an inline name edit open on IME Enter and Escape (%o)",
  async (composition) => {
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
    );
    const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "Atlas",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const windowKeys: string[] = [];
    const onWindowKey = (event: KeyboardEvent) => windowKeys.push(event.key);
    window.addEventListener("keydown", onWindowKey);
    for (const key of ["Enter", "Escape"]) {
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...composition })),
      );
    }
    window.removeEventListener("keydown", onWindowKey);
    expect(container.querySelector('[aria-label="Name"]')).toBe(input);
    // A composing Escape must not reach page-level Escape listeners such as the reply chip.
    expect(windowKeys).not.toContain("Escape");
    expect(onSave).not.toHaveBeenCalled();
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave.mock.lastCall?.[0]).toHaveProperty("name", "Atlas");
  },
);

it.each(["color", "notifyOnFinish"])(
  "restores the last accepted %s after an automatic save fails",
  async (field) => {
    await render();
    const control = () =>
      container.querySelector<HTMLButtonElement>(
        field === "color" ? '[aria-label="Avatar color"]' : 'button[id$="-notify-finish"]',
      )!;
    const value = () => control().getAttribute(field === "color" ? "data-color" : "aria-checked");
    await act(async () => control().click());
    expect(value()).toBe(field === "color" ? "blue" : "false");
    onSave.mockRejectedValueOnce(new Error("offline"));
    await act(async () => control().click());
    expect(value()).toBe(field === "color" ? "blue" : "false");
    expect(container.textContent).toContain("offline");
    expect(
      [...container.querySelectorAll("button")].some((node) => node.textContent === "Save"),
    ).toBe(false);
  },
);

it("saves a color change back to the initial value after a successful automatic save", async () => {
  await render();
  const control = () => container.querySelector<HTMLButtonElement>('[aria-label="Avatar color"]')!;
  await act(async () => control().click());
  await act(async () => control().click());
  expect(onSave.mock.lastCall?.[0]).toHaveProperty("color", "ink");
});

describe("BotSettings avatar set persistence", () => {
  it("interprets a legacy missing set as Original without saving a replacement", async () => {
    await render();
    expect(
      container.querySelector('[aria-label="Avatar set"]')?.getAttribute("data-avatar-set"),
    ).toBe("organic");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves an explicit set switch atomically with its generated colour and retains it after reload", async () => {
    await render("Billing", { color: "#10B981" });
    const control = () => container.querySelector<HTMLButtonElement>('[aria-label="Avatar set"]')!;
    await act(async () => control().click());
    expect(onSave.mock.lastCall?.[0]).toMatchObject({ avatarSet: "rakazo", color: "#F97316" });
    expect(control().getAttribute("data-avatar-set")).toBe("rakazo");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render("Billing", { color: "#F97316", avatarSet: "rakazo" });
    expect(control().getAttribute("data-avatar-set")).toBe("rakazo");
  });

  it("restores the accepted colour and set when switching fails", async () => {
    await render("Billing", { color: "#10B981" });
    onSave.mockRejectedValueOnce(new Error("offline"));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Avatar set"]')!.click(),
    );
    const control = container.querySelector('[aria-label="Avatar set"]')!;
    expect(control.getAttribute("data-avatar-set")).toBe("organic");
    expect(control.getAttribute("data-color")).toBe("#10B981");
    expect(container.textContent).toContain("offline");
  });

  it("keeps a colour edit in its existing set", async () => {
    await render("Billing", { avatarSet: "rakazo" });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Avatar color"]')!.click(),
    );
    expect(onSave.mock.lastCall?.[0]).not.toHaveProperty("avatarSet");
    expect(
      container.querySelector('[aria-label="Avatar set"]')?.getAttribute("data-avatar-set"),
    ).toBe("rakazo");
  });
});

describe("BotSettings cached data", () => {
  it("follows a newer bot in fields not edited and keeps the ones that were", async () => {
    await render("Billing");
    await setDescription("Invoices");
    await render("Remote edit", {
      name: "Grace",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(container.querySelector('[aria-label="Edit name"]')?.textContent).toBe("Grace");
    expect(descriptionField().value).toBe("Invoices");
    await clickSave();
    const patch = onSave.mock.lastCall?.[0];
    expect(patch).toMatchObject({ description: "Invoices" });
    expect(patch).not.toHaveProperty("name");
  });
});
