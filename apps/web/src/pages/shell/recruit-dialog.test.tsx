// @vitest-environment jsdom

import type { BotAvatarSet } from "@botcamp/contracts";
import type { MessageDescriptor } from "@lingui/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecruitBotInput } from "./recruit-dialog";
import type { RecruitPreset } from "./recruit-presets";

vi.mock("@lingui/react/macro", () => {
  const t = (input: TemplateStringsArray | MessageDescriptor, ...values: unknown[]) =>
    Array.isArray(input)
      ? String.raw(input as unknown as TemplateStringsArray, ...values)
      : ((input as MessageDescriptor).message ?? "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { RecruitDialog } from "./recruit-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function descriptor(message: string): MessageDescriptor {
  return { id: message, message };
}

async function render(
  onAdd: (input: RecruitBotInput) => Promise<void>,
  avatarSet: BotAvatarSet = "organic",
  presets?: readonly RecruitPreset[],
) {
  await act(async () => {
    root.render(
      <RecruitDialog
        avatarSet={avatarSet}
        presets={presets}
        onCancel={() => undefined}
        onAdd={onAdd}
      />,
    );
  });
}

async function add(preset: string) {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="recruit-add-${preset}"]`);
  if (!button) throw new Error(`No add button for ${preset}`);
  await act(async () => {
    button.click();
  });
}

async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search bots"]');
  if (!input) throw new Error("No search input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The query is deferred so typing stays responsive; let the transition settle.
  await act(async () => undefined);
}

function card(preset: string) {
  return document.querySelector(`[data-testid="recruit-${preset}"]`);
}

describe("RecruitDialog", () => {
  it("offers both ready-made roles", async () => {
    await render(async () => undefined);
    const dialog = document.querySelector('[data-testid="recruit-dialog"]');
    expect(dialog?.textContent).toContain("Software Engineer");
    expect(dialog?.textContent).toContain("Gold-Medal Editor");
    expect(document.querySelectorAll('[data-testid^="recruit-add-"]').length).toBe(2);
  });

  it("adds a role with its summary and instructions and no id on the organic set", async () => {
    const onAdd = vi.fn(async (_input: RecruitBotInput) => undefined);
    await render(onAdd);
    const preview = document.querySelector(
      '[data-testid="recruit-software-engineer"] .rakazo-organic-avatar',
    );
    const family = Number(preview?.getAttribute("data-shape-family"));
    await add("software-engineer");
    const input = onAdd.mock.lastCall?.[0];
    expect(input).toMatchObject({
      name: "Software Engineer",
      description: "Builds, tests, and ships software.",
      color: "#3B82F6",
      avatarFamily: family,
    });
    expect(input?.instructions).toContain("You are a software engineer");
    expect(input).not.toHaveProperty("id");
  });

  it("keeps the preview id on the legacy set", async () => {
    const onAdd = vi.fn(async (_input: RecruitBotInput) => undefined);
    await render(onAdd, "rakazo");
    await add("gold-medal-editor");
    const input = onAdd.mock.lastCall?.[0];
    expect(input?.id).toMatch(/^c[a-z0-9]{24}$/);
    expect(input).not.toHaveProperty("avatarFamily");
    expect(input?.name).toBe("Gold-Medal Editor");
  });

  it("filters the catalog by name and summary, and says when nothing matches", async () => {
    await render(async () => undefined);
    await search("editor");
    expect(card("software-engineer")).toBeNull();
    expect(card("gold-medal-editor")).not.toBeNull();
    await search("ship");
    expect(card("software-engineer")).not.toBeNull();
    expect(card("gold-medal-editor")).toBeNull();
    await search("zzz");
    expect(document.body.textContent).toContain("No bots match");
    await search("");
    expect(card("software-engineer")).not.toBeNull();
    expect(card("gold-medal-editor")).not.toBeNull();
  });

  it("renders one page at a time and loads the rest on request", async () => {
    const presets: RecruitPreset[] = Array.from({ length: 61 }, (_, index) => ({
      id: `role-${index}`,
      name: descriptor(`Role ${index}`),
      summary: descriptor("Does the job."),
      instructions: descriptor("Do the job."),
      color: "#3B82F6",
    }));
    await render(async () => undefined, "organic", presets);
    expect(document.querySelectorAll('[data-testid^="recruit-add-"]').length).toBe(60);
    const more = document.querySelector<HTMLButtonElement>('[data-testid="recruit-show-more"]');
    expect(more).not.toBeNull();
    await act(async () => {
      more!.click();
    });
    expect(document.querySelectorAll('[data-testid^="recruit-add-"]').length).toBe(61);
    expect(document.querySelector('[data-testid="recruit-show-more"]')).toBeNull();
  });

  it("disables adding while one is in flight and shows the error when it fails", async () => {
    let fail!: () => void;
    const onAdd = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = () => reject(new Error("Bot limit reached"));
        }),
    );
    await render(onAdd);
    await add("software-engineer");
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid^="recruit-add-"]'),
    ];
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await act(async () => {
      fail();
    });
    expect(document.querySelector('[data-testid="recruit-error"]')?.textContent).toBe(
      "Bot limit reached",
    );
    expect(document.querySelector('[data-testid="recruit-dialog"]')).not.toBeNull();
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });
});
