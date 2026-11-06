// @vitest-environment jsdom

import type { BotCampDesktop, DesktopUpdateState } from "@rakazo/contracts";
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

function checkButtons(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter((item) =>
    item.textContent?.includes("检查更新"),
  );
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
  document.title = "BotCamp";
  delete window.rakazoDesktop;
  delete window.__RAKAZO_API_ORIGIN__;
});

function desktopBridge(update: BotCampDesktop["update"]): BotCampDesktop {
  return {
    platform: "win32",
    window: {
      close: async () => {},
      minimize: async () => {},
      toggleMaximize: async () => {},
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    oauth: { onCallback: () => () => {} },
    update,
  };
}

it("checks the installed desktop release and offers that platform's installer", async () => {
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
          mac: "https://downloads.test/BotCamp-0.7.2-arm64.dmg",
        }),
      };
    }
    return { ok: false, text: async () => "", json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(
    createElement(AboutBotCamp, { client: { platform: "windows", version: "0.7.1" } }),
  );
  try {
    await view.show();
    expect(view.container.textContent).toContain("Windows · 0.7.1");
    expect(view.container.textContent).not.toContain("20261105134607");
    expect(view.container.textContent).not.toContain("网页端");
    const button = [...view.container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("检查更新"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(view.container.textContent).toContain("有新版本 0.7.2");
    expect(view.container.textContent).not.toContain("已是最新版本");
    expect(checkButtons(view.container)).toHaveLength(0);
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://downloads.test/BotCamp-Setup-0.7.2.exe",
    );
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("build-id"))).toBe(false);
  } finally {
    await view.cleanup();
  }
});

it("names the web console without a version or an update button", async () => {
  installWindowsAgent();
  const fetchMock = vi.fn(async () => ({ ok: true, text: async () => "20261105134607\n" }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(createElement(AboutBotCamp));
  try {
    await view.show();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("网页端");
    expect(view.container.textContent).not.toContain("20261105134607");
    expect(view.container.textContent).not.toContain("Windows");
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.querySelector("a")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
  window.rakazoDesktop = desktopBridge({
    state: async () => unsupported,
    check: async () => unsupported,
    download: async () => unsupported,
    install: async () => unsupported,
  });
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
  const view = render(createElement(DesktopUpdatesProvider, null, createElement(DesktopAbout)));
  try {
    await view.show();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.textContent).toContain("Windows · 0.7.1");
    expect(view.container.textContent).not.toContain("自动更新仅在已安装的版本中运行");
    expect(view.container.textContent).not.toContain("20261105134607");
    expect(view.container.textContent).not.toContain("Desktop app");
    const buttons = checkButtons(view.container);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toContain("检查更新");
    expect(view.container.textContent).not.toContain("网页端");
  } finally {
    await view.cleanup();
  }
});

it("offers a newer Windows installer without moving the Mac release", async () => {
  window.__RAKAZO_API_ORIGIN__ = "https://api.test";
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      desktopVersion: "0.7.2",
      windowsVersion: "0.7.3",
      windows: "https://downloads.test/BotCamp-Setup-0.7.3.exe",
      mac: "https://downloads.test/BotCamp-0.7.2-arm64.dmg",
    }),
  }));
  const windows = render(
    createElement(AboutBotCamp, { client: { platform: "windows", version: "0.7.2" } }),
  );
  const mac = render(
    createElement(AboutBotCamp, { client: { platform: "mac", version: "0.7.2" } }),
  );
  try {
    await windows.show();
    await act(async () => {
      checkButtons(windows.container)[0]?.click();
    });
    expect(windows.container.textContent).toContain("有新版本 0.7.3");
    expect(windows.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://downloads.test/BotCamp-Setup-0.7.3.exe",
    );
    await mac.show();
    await act(async () => {
      checkButtons(mac.container)[0]?.click();
    });
    expect(mac.container.textContent).toContain("已是最新版本");
    expect(mac.container.querySelector("a")).toBeNull();
  } finally {
    await windows.cleanup();
    await mac.cleanup();
  }
});

it("downloads a newer build inside an app that has an update feed", async () => {
  const ready: DesktopUpdateState = {
    phase: "ready",
    currentVersion: "0.7.3",
    availableVersion: "0.7.4",
    percent: null,
    message: null,
    checkedAt: "2026-11-05T00:00:00.000Z",
  };
  const install = vi.fn(async () => ready);
  window.rakazoDesktop = desktopBridge({
    state: async () => ready,
    check: async () => ready,
    download: async () => ready,
    install,
  });
  const view = render(createElement(DesktopUpdatesProvider, null, createElement(DesktopAbout)));
  try {
    await view.show();
    expect(view.container.textContent).toContain("Windows · 0.7.3");
    expect(view.container.querySelector("a")).toBeNull();
    const button = [...view.container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("重启并更新"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(install).toHaveBeenCalledOnce();
  } finally {
    await view.cleanup();
  }
});

it("does not send a Windows app to another platform's installer", async () => {
  window.__RAKAZO_API_ORIGIN__ = "https://api.test";
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({
      desktopVersion: "0.7.2",
      mac: "https://downloads.test/BotCamp-0.7.2-arm64.dmg",
    }),
  }));
  const view = render(
    createElement(AboutBotCamp, { client: { platform: "windows", version: "0.7.1" } }),
  );
  try {
    await view.show();
    await act(async () => {
      checkButtons(view.container)[0]?.click();
    });
    expect(view.container.textContent).toContain("检查更新失败，请稍后再试");
    expect(view.container.querySelector("a")).toBeNull();
    expect(view.container.textContent).not.toContain("有新版本");
  } finally {
    await view.cleanup();
  }
});

it("checks the Android release against the Android installer", async () => {
  window.__BOTCAMP_APP__ = { platform: "android", version: "2.1.1" };
  window.__RAKAZO_API_ORIGIN__ = "https://api.test";
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).endsWith("/downloads/latest.json")) {
      return {
        ok: true,
        json: async () => ({
          version: "2.1.2",
          desktopVersion: "0.7.2",
          android: "https://downloads.test/BotCamp-2.1.2.apk",
          windows: "https://downloads.test/BotCamp-Setup-0.7.2.exe",
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  });
  const view = render(createElement(DesktopUpdatesProvider, null, createElement(DesktopAbout)));
  try {
    await view.show();
    expect(view.container.textContent).toContain("Android · 2.1.1");
    const button = checkButtons(view.container)[0];
    await act(async () => {
      button?.click();
    });
    expect(view.container.textContent).toContain("有新版本 2.1.2");
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "https://downloads.test/BotCamp-2.1.2.apk",
    );
  } finally {
    delete window.__BOTCAMP_APP__;
    await view.cleanup();
  }
});

it("hands the build over for a bug report instead of asking the user to retype it", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const view = render(
    createElement(AboutBotCamp, { client: { platform: "windows", version: "0.7.1" } }),
  );
  try {
    await view.show();
    const copy = [...view.container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("复制"),
    );
    expect(copy).toBeTruthy();
    await act(async () => {
      copy?.click();
    });
    expect(writeText).toHaveBeenCalledWith("BotCamp 0.7.1 · Windows");
  } finally {
    delete (navigator as { clipboard?: unknown }).clipboard;
    await view.cleanup();
  }
});

it("names the installed build in the window title, so a screenshot carries it", async () => {
  const state: DesktopUpdateState = {
    phase: "idle",
    currentVersion: "0.7.1",
    availableVersion: null,
    percent: null,
    message: null,
    checkedAt: null,
  };
  window.rakazoDesktop = desktopBridge({
    state: async () => state,
    check: async () => state,
    download: async () => state,
    install: async () => state,
  });
  const view = render(
    createElement(DesktopUpdatesProvider, null, createElement("div", null, "console")),
  );
  try {
    await view.show();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.title).toBe("BotCamp 0.7.1");
  } finally {
    await view.cleanup();
  }
});
