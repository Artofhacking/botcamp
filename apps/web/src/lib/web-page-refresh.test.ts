import { describe, expect, it, vi } from "vitest";
import { refreshWebPage, reloadsOntoServed } from "./web-page-refresh.js";

describe("page reload decision", () => {
  it("reloads onto a newer served build", () => {
    expect(reloadsOntoServed("20261101090000", "20261113120000")).toBe(true);
  });

  it("stays put when the server serves this build", () => {
    expect(reloadsOntoServed("20261113120000", "20261113120000")).toBe(false);
  });

  it("stays put when the server serves an older build, as before a deploy finishes", () => {
    expect(reloadsOntoServed("20261113120000", "20261101090000")).toBe(false);
  });

  it("reloads when either side cannot name a build, since a reload is all that is left", () => {
    expect(reloadsOntoServed("", "20261113120000")).toBe(true);
    expect(reloadsOntoServed("20261113120000", null)).toBe(true);
    expect(reloadsOntoServed("20261113120000", "unknown")).toBe(true);
  });
});

describe("refreshWebPage", () => {
  it("reloads through the shell once the server confirms a newer build", async () => {
    const shellReload = vi.fn(async () => {});
    const browserReload = vi.fn();

    await expect(
      refreshWebPage({
        page: "20261101090000",
        served: async () => "20261113120000",
        shellReload,
        browserReload,
      }),
    ).resolves.toBe("reloaded");
    expect(shellReload).toHaveBeenCalledTimes(1);
    expect(browserReload).not.toHaveBeenCalled();
  });

  it("reloads a plain tab itself", async () => {
    const browserReload = vi.fn();

    await expect(
      refreshWebPage({
        page: "20261101090000",
        served: async () => "20261113120000",
        browserReload,
      }),
    ).resolves.toBe("reloaded");
    expect(browserReload).toHaveBeenCalledTimes(1);
  });

  it("leaves the page alone when it already runs the served build", async () => {
    const shellReload = vi.fn(async () => {});
    const browserReload = vi.fn();

    await expect(
      refreshWebPage({
        page: "20261113120000",
        served: async () => "20261113120000",
        shellReload,
        browserReload,
      }),
    ).resolves.toBe("current");
    expect(shellReload).not.toHaveBeenCalled();
    expect(browserReload).not.toHaveBeenCalled();
  });

  it("still reloads when the server cannot be asked", async () => {
    const browserReload = vi.fn();

    await expect(
      refreshWebPage({
        page: "20261113120000",
        served: async () => {
          throw new Error("offline");
        },
        browserReload,
      }),
    ).resolves.toBe("reloaded");
    expect(browserReload).toHaveBeenCalledTimes(1);
  });
});
