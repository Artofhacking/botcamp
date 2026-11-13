import { describe, expect, it, vi } from "vitest";
import {
  httpsBundleIdFromLaunchServices,
  isEphemeralChromeCommand,
  openSystemBrowser,
  preferredChromeOpenArgs,
  type ChromeOpenContext,
} from "./system-browser.js";

const home = "/Users/test";
const signedIn = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --restart --restart";
const automated = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "--enable-automation",
  "--user-data-dir=/tmp/chrome-automation",
  "--remote-debugging-pipe",
].join(" ");

function context(overrides: Partial<ChromeOpenContext> = {}): ChromeOpenContext {
  return {
    platform: "darwin",
    home,
    defaultHttpsBundleId: "com.google.chrome",
    commands: [signedIn, automated],
    ...overrides,
  };
}

describe("signed-in Chrome", () => {
  it("reads the https handler", () => {
    expect(
      httpsBundleIdFromLaunchServices({
        LSHandlers: [
          { LSHandlerURLScheme: "http", LSHandlerRoleAll: "com.apple.safari" },
          { LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" },
        ],
      }),
    ).toBe("com.google.chrome");
    expect(httpsBundleIdFromLaunchServices({ LSHandlers: [] })).toBeNull();
    expect(
      httpsBundleIdFromLaunchServices({
        LSHandlers: [{ LSHandlerURLScheme: "https", LSHandlerRoleAll: "-" }],
      }),
    ).toBeNull();
  });

  it("recognizes an automated Chrome and ignores the signed-in one", () => {
    expect(isEphemeralChromeCommand(automated)).toBe(true);
    expect(isEphemeralChromeCommand(`${signedIn} --remote-debugging-port=9222`)).toBe(true);
    expect(isEphemeralChromeCommand(signedIn)).toBe(false);
    expect(isEphemeralChromeCommand("/Applications/Safari.app/Contents/MacOS/Safari")).toBe(false);
  });

  it("pins the link to the normal Chrome profile while an automated copy is running", () => {
    expect(preferredChromeOpenArgs(context(), "https://botcamp.example/console/")).toEqual([
      "-na",
      "Google Chrome",
      "--args",
      "--user-data-dir=/Users/test/Library/Application Support/Google/Chrome",
      "https://botcamp.example/console/",
    ]);
  });

  it("keeps the ordinary handoff when Chrome is already the only copy", () => {
    expect(
      preferredChromeOpenArgs(context({ commands: [signedIn] }), "https://botcamp.example/"),
    ).toBeNull();
    expect(
      preferredChromeOpenArgs(
        context({ defaultHttpsBundleId: "com.apple.safari" }),
        "https://botcamp.example/",
      ),
    ).toBeNull();
    expect(
      preferredChromeOpenArgs(context({ platform: "win32" }), "https://botcamp.example/"),
    ).toBeNull();
    expect(preferredChromeOpenArgs(context(), "rakazo://sso")).toBeNull();
  });

  it("uses the pinned launch and falls back when that launch fails", async () => {
    const openExternal = vi.fn(async () => undefined);
    const launch = vi.fn(async () => undefined);
    await openSystemBrowser("https://botcamp.example/", openExternal, {
      discover: async () => context(),
      launch,
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(openExternal).not.toHaveBeenCalled();

    launch.mockRejectedValueOnce(new Error("open failed"));
    await openSystemBrowser("https://botcamp.example/", openExternal, {
      discover: async () => context(),
      launch,
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://botcamp.example/");
  });

  it("leaves end-to-end launches on the ordinary handoff", async () => {
    process.env.RAKAZO_E2E_EXECUTABLE = "1";
    const openExternal = vi.fn(async () => undefined);
    const launch = vi.fn(async () => undefined);
    try {
      await openSystemBrowser("https://botcamp.example/", openExternal, {
        discover: async () => context(),
        launch,
      });
    } finally {
      delete process.env.RAKAZO_E2E_EXECUTABLE;
    }
    expect(launch).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("uses the ordinary handoff when no automated Chrome is running", async () => {
    const openExternal = vi.fn(async () => undefined);
    const launch = vi.fn(async () => undefined);
    await openSystemBrowser("https://botcamp.example/", openExternal, {
      discover: async () => context({ commands: [signedIn] }),
      launch,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledOnce();
  });
});
