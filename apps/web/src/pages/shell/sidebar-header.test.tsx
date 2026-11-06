// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: { children?: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../lib/desktop", () => ({
  desktopBridge: () => undefined,
  windowChromeKind: () => "spacer",
}));
vi.mock("./bot-picker", () => ({ BotCreatePicker: () => null }));

import { SidebarHeader } from "./sidebar-header";

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

function renderHeader(mini = false) {
  act(() => {
    root.render(
      <SidebarHeader
        mini={mini}
        createMenuOpen={false}
        setCreateMenuOpen={() => undefined}
        activityMode={false}
        toggleActivityMode={() => undefined}
        onSearch={() => undefined}
        setBotsSidebarCollapsedPref={() => undefined}
        bots={[]}
        setMobileSidebarOpen={() => undefined}
        setPanel={() => undefined}
        navigate={() => undefined}
        setCreateBotOpen={() => undefined}
      />,
    );
  });
}

describe("sidebar brand", () => {
  it("opens the site homepage in a new page", () => {
    renderHeader();
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="brand-home"]');
    expect(link).not.toBeNull();
    expect(link?.href).toBe(new URL("/", window.location.origin).href);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noopener");
    expect(link?.textContent).toBe("");
    expect(link?.getAttribute("aria-label")).toBe("BotCamp");
    expect(link?.querySelector("img")?.getAttribute("src")).toBe("/icon-192.png");
  });

  it("keeps the name off the icon-only sidebar and still names the link", () => {
    renderHeader(true);
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="brand-home"]');
    expect(link?.textContent).toBe("");
    expect(link?.getAttribute("aria-label")).toBe("BotCamp");
    expect(link?.querySelector("img")).not.toBeNull();
  });
});
