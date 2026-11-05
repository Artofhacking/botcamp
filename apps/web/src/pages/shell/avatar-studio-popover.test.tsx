// @vitest-environment jsdom

import type { BotAvatarSet } from "@rakazo/contracts";
import { resolvePersonaColorDef } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AvatarStudioPopover } from "./avatar-studio-popover";

let container: HTMLDivElement;
let root: Root;
const changed = vi.fn<(value: string, avatarSet?: BotAvatarSet) => void>();

function Harness({
  value: initial,
  avatarSet: initialSet,
}: {
  value: string;
  avatarSet?: BotAvatarSet;
}) {
  const [value, setValue] = useState(initial);
  const [avatarSet, setAvatarSet] = useState(initialSet);
  return (
    <AvatarStudioPopover
      value={value}
      identity="sample-bot"
      avatarSet={avatarSet}
      onChange={(next, nextSet) => {
        changed(next, nextSet);
        setValue(next);
        if (nextSet !== undefined) setAvatarSet(nextSet);
      }}
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changed.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(value: string, avatarSet?: BotAvatarSet, key = "initial") {
  await act(async () => root.render(<Harness key={key} value={value} avatarSet={avatarSet} />));
}

describe("avatar studio", () => {
  it("edits the original look and does not offer another icon set", async () => {
    await render("#10B981");
    await click("Customize bot avatar");
    const studio = document.querySelector("[data-testid='avatar-studio']");
    expect(studio?.textContent).not.toContain("BotCamp");
    expect(studio?.querySelector(".rakazo-organic-avatar")).not.toBeNull();
    expect(studio?.querySelector(".rakazo-logo-avatar")).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    expect(button("wedge")).toBeDefined();
    await click("Color #00C972");
    expect(changed).toHaveBeenLastCalledWith("#00C972", undefined);
  });

  it("shows the original look when the bot was saved on the other set", async () => {
    await render("#10B981", "rakazo");
    await click("Customize bot avatar");
    const studio = document.querySelector("[data-testid='avatar-studio']");
    expect(studio?.textContent).not.toContain("BotCamp");
    expect(studio?.querySelector(".rakazo-logo-avatar")).toBeNull();
    expect(studio?.querySelector(".rakazo-organic-avatar")).not.toBeNull();
    await click("Color #00C972");
    expect(changed).toHaveBeenLastCalledWith("#00C972", "organic");
  });

  it("leaves a photo intact until a shape is chosen", async () => {
    const photo = "data:image/png;base64,abc";
    await render(photo);
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("wedge");
    // A photo has no stored color, so the picker uses the orange it already draws, and wedge is shape 1.
    const orange = resolvePersonaColorDef("preview", "#F97316").hex;
    expect(changed).toHaveBeenLastCalledWith(`${orange}::shape_1`, undefined);
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
  });

  it("keeps an explicit original shape while changing colour", async () => {
    await render("#8B5CF6::shape_2", "organic");
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    await click("Color #00C972");
    expect(changed).toHaveBeenLastCalledWith("#00C972::shape_2", undefined);
  });
});
