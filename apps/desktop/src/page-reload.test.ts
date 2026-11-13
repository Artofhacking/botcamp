import { describe, expect, it, vi } from "vitest";
import type { AppTarget } from "./app-frame.js";
import { createPageReloadHandler } from "./page-reload.js";

const ORIGIN = "https://botcamp.example.com";

/** A window's page: the webContents is its own main frame, as Electron reports an IPC event. */
function page(url = `${ORIGIN}/`) {
  const reloadIgnoringCache = vi.fn();
  const frame = {
    url,
    mainFrame: null as unknown,
    isDestroyed: () => false,
    reloadIgnoringCache,
  };
  frame.mainFrame = frame;
  return {
    reloadIgnoringCache,
    frame,
    page: { webContents: frame, url } as unknown as AppTarget,
  };
}

describe("desktop page reload", () => {
  it("reloads the page without its HTTP cache when the app frame asks", () => {
    const target = page();
    const reload = createPageReloadHandler(() => target.page);

    expect(reload({ sender: target.frame, senderFrame: target.frame } as never)).toBe(true);
    expect(target.reloadIgnoringCache).toHaveBeenCalledTimes(1);
  });

  it("refuses a page on another origin", () => {
    const target = page();
    const reload = createPageReloadHandler(() => target.page);
    const elsewhere = page("https://attacker.example/");

    expect(reload({ sender: elsewhere.frame, senderFrame: elsewhere.frame } as never)).toBe(false);
    expect(target.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it("refuses a subframe of the page", () => {
    const target = page();
    const reload = createPageReloadHandler(() => target.page);
    const subframe = { url: `${ORIGIN}/frame` };

    expect(reload({ sender: target.frame, senderFrame: subframe } as never)).toBe(false);
    expect(target.reloadIgnoringCache).not.toHaveBeenCalled();
  });

  it("does nothing when there is no window", () => {
    const target = page();
    const reload = createPageReloadHandler(() => null);

    expect(reload({ sender: target.frame, senderFrame: target.frame } as never)).toBe(false);
  });
});
