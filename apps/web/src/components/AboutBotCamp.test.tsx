// @vitest-environment jsdom

import type { DesktopUpdateState } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AboutBotCamp } from "./AboutBotCamp";
import { DesktopAbout, DesktopUpdatesProvider } from "./DesktopUpdates";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

function installWindowsAgent() {
  Object.defineProperty(navigator, "userAgent", { value: WINDOWS, configurable: true });
}

function render(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    async show() {
      await act(async () => {
        root.render(node);
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.rakazoDesktop;
  delete window.__RAKAZO_API_ORIGIN__;
});

it("checks the desktop release instead of the web build id", async () => {
  installWindowsAgent();
  window.__RAKAZO_API_ORIGIN__ = "https://api.test";
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/downloads/latest.json")) {
      return {
        ok: true,
        json: async () => ({
          version: "2.1.2",
          desktopVersion: "0.7.2",
          windows: "https://downloads.test/BotCamp-Setup-0.7.2.exe",
        }),
      };
    }
    return { ok: false, text: async () => "", json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(AboutBotCamp, { appVersion: "0.7.1" }));
  try {
    await view.show();
    expect(view.container.textContent).toContain("Windows · 0.7.1");
    expect(view.container.textContent).not.toContain("20261105134607");
    const button = [...view.container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("检查更新"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(view.container.textContent).toContain("有新版本 0.7.2");
    expect(view.container.textContent).not.toContain("已是最新版本");
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://downloads.test/BotCamp-Setup-0.7.2.exe",
    );
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("build-id"))).toBe(false);
  } finally {
    await view.cleanup();
  }
});

it("does not treat a web build id as a desktop release", async () => {
  installWindowsAgent();
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("build-id")) return { ok: true, text: async () => "20261105134607\n" };
    return { ok: false, text: async () => "", json: async () => ({}) };
  });
  const view = render(createElement(AboutBotCamp));
  try {
    await view.show();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("20261105134607");
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).not.toContain("已是最新版本");
  } finally {
    await view.cleanup();
  }
});

it("shows one check for an installed app that has no auto-update feed", async () => {
  installWindowsAgent();
  window.__RAKAZO_API_ORIGIN__ = "https://api.test";
  const unsupported: DesktopUpdateState = {
    phase: "unsupported",
    currentVersion: "0.7.1",
    availableVersion: null,
    percent: null,
    message: "自动更新仅在已安装的版本中运行。",
    checkedAt: null,
  };
  window.rakazoDesktop = {
    update: {
      state: async () => unsupported,
      check: async () => unsupported,
      download: async () => unsupported,
      install: async () => unsupported,
    },
  };
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).endsWith("/downloads/latest.json")) {
      return {
        ok: true,
        json: async () => ({
          desktopVersion: "0.7.2",
          windows: "https://downloads.test/BotCamp-Setup-0.7.2.exe",
        }),
      };
    }
    return { ok: true, text: async () => "20261105134607\n", json: async () => ({}) };
  });
  const view = render(
    createElement(DesktopUpdatesProvider, null, createElement(DesktopAbout)),
  );
  try {
    await view.show();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Windows · 0.7.1");
    expect(view.container.textContent).not.toContain("自动更新仅在已安装的版本中运行");
    expect(view.container.textContent).not.toContain("20261105134607");
    expect(view.container.textContent).not.toContain("Desktop app");
    const buttons = [...view.container.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("检查更新");
  } finally {
    await view.cleanup();
  }
});
