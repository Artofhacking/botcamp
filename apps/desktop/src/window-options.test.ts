import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserWindowOptions,
  DEFAULT_WARM_WINDOW_TTL_MS,
  developmentIconFile,
  setupWindowOptions,
  WINDOWS_APP_USER_MODEL_ID,
  warmWindowTtlMs,
  windowsAppUserModelId,
} from "./window-options.js";

const laptop = { width: 1440, height: 875 };

describe("desktop window chrome", () => {
  it("uses native traffic lights on macOS", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.frame).toBe(true);
    expect(opts.titleBarStyle).toBe("hiddenInset");
    expect(opts.trafficLightPosition).toEqual({ x: 16, y: 16 });
  });

  it("uses the native Windows frame in the app and setup windows", () => {
    for (const opts of [
      browserWindowOptions("win32", laptop),
      setupWindowOptions("win32", laptop),
    ]) {
      expect(opts.frame).toBe(true);
      expect(opts.titleBarStyle).toBeUndefined();
      expect(opts.trafficLightPosition).toBeUndefined();
    }
  });

  it("keeps Linux frameless so its in-app buttons control the window", () => {
    const opts = browserWindowOptions("linux", laptop);
    expect(opts.frame).toBe(false);
    expect(opts.titleBarStyle).toBeUndefined();
  });
});

describe("app window size", () => {
  it("opens smaller than a laptop screen so it reads as a window, not full screen", () => {
    const opts = browserWindowOptions("darwin", laptop);
    expect(opts.width).toBeLessThan(laptop.width);
    expect(opts.height).toBeLessThan(laptop.height);
  });

  it("fits inside a small scaled screen", () => {
    const small = { width: 1280, height: 672 };
    for (const opts of [browserWindowOptions("win32", small), setupWindowOptions("win32", small)]) {
      expect(opts.width).toBeLessThanOrEqual(small.width);
      expect(opts.height).toBeLessThanOrEqual(small.height);
    }
    const setup = setupWindowOptions("win32", small);
    expect(setup.minHeight).toBeLessThanOrEqual(setup.height);
  });

  it("caps its size on large displays", () => {
    expect(browserWindowOptions("darwin", { width: 3840, height: 2160 })).toMatchObject({
      width: 1280,
      height: 840,
    });
  });
});

describe("setup window chrome", () => {
  it("matches the app window chrome so first run looks like the product", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const setup = setupWindowOptions(platform, laptop);
      const app = browserWindowOptions(platform, laptop);
      expect(setup.frame).toBe(app.frame);
      expect(setup.titleBarStyle).toBe(app.titleBarStyle);
      expect(setup.backgroundColor).toBe(app.backgroundColor);
    }
  });

  it("opens smaller than the app window and stays usable when resized down", () => {
    const setup = setupWindowOptions("win32", laptop);
    expect(setup.width).toBeLessThan(browserWindowOptions("win32", laptop).width);
    expect(setup.minWidth).toBeLessThanOrEqual(setup.width);
    expect(setup.minHeight).toBeLessThanOrEqual(setup.height);
  });
});

describe("warm window lifetime", () => {
  it("accepts finite timer delays within Node's supported range", () => {
    expect(warmWindowTtlMs("0")).toBe(0);
    expect(warmWindowTtlMs("900000")).toBe(900_000);
    expect(warmWindowTtlMs("2147483647")).toBe(2_147_483_647);
  });

  it.each([undefined, "", " ", "nope", "-1", "Infinity", "2147483648"])(
    "uses the default for an invalid value (%s)",
    (value) => {
      expect(warmWindowTtlMs(value)).toBe(DEFAULT_WARM_WINDOW_TTL_MS);
    },
  );
});

describe("development icon", () => {
  it("uses the squircle asset on macOS because the dock draws the file unmasked", () => {
    expect(developmentIconFile("darwin")).toBe("icon-macos.png");
  });

  it("keeps the full-bleed icon elsewhere", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(developmentIconFile(platform)).toBe("icon.png");
    }
  });
});

describe("windows shell identity", () => {
  it("uses the installer app id only for a packaged Windows app", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
    ) as { build: { appId: string } };
    expect(WINDOWS_APP_USER_MODEL_ID).toBe(pkg.build.appId);
    expect(windowsAppUserModelId("win32", true)).toBe(pkg.build.appId);
    expect(windowsAppUserModelId("win32", false)).toBeUndefined();
    expect(windowsAppUserModelId("darwin", true)).toBeUndefined();
    expect(windowsAppUserModelId("linux", true)).toBeUndefined();
  });

  it("points Start menu and taskbar shortcuts at a per-version icon", () => {
    const script = readFileSync(path.join(import.meta.dirname, "../assets/installer.nsh"), "utf8");
    expect(script).toContain("!macro customInstall");
    expect(script).toContain("BotCamp-${VERSION}.ico");
    expect(script).toContain("${BUILD_RESOURCES_DIR}\\icon.ico");
    expect(script).toContain("$newStartMenuLink");
    expect(script).toContain("User Pinned\\TaskBar\\${SHORTCUT_NAME}.lnk");
    expect(script).toContain('WinShell::SetLnkAUMI "${link}" "${APP_ID}"');
  });
});

describe("window background", () => {
  it("matches the web dark background token so startup chrome does not flash", async () => {
    const { webDarkTokens } = await import("@botcamp/ui-tokens");
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(browserWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
      expect(setupWindowOptions(platform, laptop).backgroundColor).toBe(webDarkTokens.background);
    }
  });
});
