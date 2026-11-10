// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => {
  const rpc = {
    voice: { voices: vi.fn(async () => []) },
    models: {
      credentials: vi.fn(async () => []),
      list: vi.fn(async () => []),
    },
    me: vi.fn(async () => ({})),
    messaging: {
      chatTools: {
        list: vi.fn(async () => []),
        start: vi.fn(async () => ({ loginId: "login-1", image: "", expiresAt: "" })),
        poll: vi.fn(async () => ({ status: "wait" })),
        unlink: vi.fn(async () => ({ ok: true })),
      },
    },
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
vi.mock("@rakazo/ui-web", () => ({
  SectionHeading: ({ variant, ...props }: ComponentProps<"h3"> & { variant?: string }) => (
    <h3 data-variant={variant} {...props} />
  ),
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: ({ size: _size, ...props }: ComponentProps<"select"> & { size?: string }) => (
    <select {...props} />
  ),
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Switch: ({
    checked,
    onCheckedChange,
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
    pressed: _pressed,
    onPressedChange: _onPressedChange,
    ...props
  }: ComponentProps<"button"> & {
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    variant?: string;
  }) => <button type="button" {...props} />,
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
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));

import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const bot = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Ada",
  title: "Helper",
  description: "Helps",
  instructions: "Helps",
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
  computerMode: "dedicated",
  updatedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: ["remember"],
  webhookConfigured: false,
  spawnKey: null,
} as Bot;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  queryClient.clear();
  container.remove();
});

type SavePatch = {
  disabledBuiltinTools?: string[];
  name?: string;
  title?: string;
  fleetManagement?: boolean;
};

function setField(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitToolName(input: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function renderSettings(onSave: (patch: SavePatch) => Promise<void>, currentBot = bot) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <BotSettings
          focusModel={1}
          bot={currentBot}
          memoryProviderConfigured={false}
          onSave={onSave}
          onExport={async () => undefined}
          onClear={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  await flush();
}

it("omits projected identity values on unrelated saves but commits explicit inline edits", async () => {
  const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
  await renderSettings(onSave, { ...bot, name: "Бот" });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[id$="-notify-finish"]')!.click(),
  );
  expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("name");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Edit name"]')!.click(),
  );
  const input = container.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  await act(async () => setField(input, "SupportBot2026"));
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onSave.mock.calls[1]?.[0]).toMatchObject({ name: "SupportBot2026" });
});

it("uses section headings without repeating notification or model row labels", async () => {
  await renderSettings(vi.fn(async () => undefined));
  const heading = [...container.querySelectorAll("h3")].find(
    (node) => node.textContent === "Notifications",
  );
  expect(heading).toBeDefined();
  expect(heading?.dataset.variant).toBe("label");
  const notification = container.querySelector('label[id$="-notify-finish-label"]');
  expect(notification?.textContent?.trim()).toBe("When it finishes or needs input");
  expect(container.querySelector('label[for$="-model"]')).toBeNull();
});

it("treats cross-space communication as on unless turned off", async () => {
  const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
  await renderSettings(onSave);
  const toggle = container.querySelector<HTMLButtonElement>('[id$="-cross-space"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle?.click());
  await flush();
  expect(onSave).toHaveBeenCalledWith({ crossSpaceCommunication: false });
});

it("links a chat app from the primary bot and hides it on the others", async () => {
  const list = rpc.messaging.chatTools.list as ReturnType<typeof vi.fn>;
  list.mockClear();
  await renderSettings(vi.fn(async () => undefined));
  expect(container.querySelector("[data-testid=chat-tool-link]")).toBeNull();
  expect(list).not.toHaveBeenCalled();

  await renderSettings(
    vi.fn(async () => undefined),
    { ...bot, isPrimary: true },
  );
  await flush();
  const row = container.querySelector("[data-testid=chat-tool-link]");
  expect(row?.textContent).toContain("Link your chat app");
  expect(row?.querySelector("select")).toBeNull();
  const description = container.querySelector('textarea[aria-label="How other bots see it"]');
  const exportButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export",
  );
  if (!row || !description || !exportButton) throw new Error("missing chat app row");
  expect(description.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.compareDocumentPosition(exportButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const start = rpc.messaging.chatTools.start as ReturnType<typeof vi.fn>;
  start.mockResolvedValue({
    loginId: "login-1",
    image: "https://liteapp.weixin.qq.com/q/abc",
    expiresAt: "2026-11-10T00:00:00.000Z",
  });
  const link = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Link",
  );
  await act(async () => link?.click());
  await flush();
  const wechat = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "WeChat",
  );
  expect(wechat).toBeDefined();
  await act(async () => wechat?.click());
  await flush();
  await flush();
  expect(start).toHaveBeenCalledWith({ botId: "bot-1", provider: "weixin" });
  const code = container.querySelector("img");
  expect(code?.getAttribute("alt")).toBe("Chat app code");
  expect(code?.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
  expect(code?.getAttribute("src")).not.toBe("https://liteapp.weixin.qq.com/q/abc");
});

it("defaults daily check-ins on and saves the opt-out", async () => {
  const onSave = vi.fn<(patch: SavePatch) => Promise<void>>(async () => undefined);
  await renderSettings(onSave);
  const toggle = container.querySelector<HTMLButtonElement>('[id$="-daily-check-ins"]');
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('label[for$="-daily-check-ins"]')?.textContent?.trim()).toBe(
    "Daily check-ins on unfinished work",
  );
  await act(async () => toggle?.click());
  await flush();
  expect(onSave).toHaveBeenCalledWith({ dailyCheckIns: false });
});
