import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOGS,
  createLocaleHandler,
  desktopLocale,
  desktopMessages,
  errorDetail,
  resolveDesktopLocale,
  startDesktopLocale,
  t,
  withDetail,
} from "./i18n.js";
import { ZH_CN_MESSAGES } from "./locales/zh-CN.js";
import { readUiLocale, writeUiLocale } from "./setup-store.js";

const srcDir = import.meta.dirname;

/** Literal `t("…")` ids; the formatter keeps every string double-quoted. */
function translationIds(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*("(?:\\.|[^"\\])*")/g)].map(
    (match) => JSON.parse(match[1] ?? '""') as string,
  );
}

function placeholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "").sort();
}

function appFrame(url = "https://app.example.com/bots") {
  const frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as IpcMainInvokeEvent;
  return { event, target: { webContents: contents, url: "https://app.example.com" } };
}

afterEach(() => {
  startDesktopLocale(null, "en-US");
});

describe("desktop language", () => {
  it.each([
    ["zh-CN", "en-US", "zh-CN"],
    ["en", "zh-HK", "en"],
    [null, "zh-TW", "zh-CN"],
    [null, "zh_HK", "zh-CN"],
    // The app offers languages the desktop has no catalog for; those read English.
    ["it", "zh-CN", "en"],
    [null, "it-IT", "en"],
    [null, undefined, "en"],
  ] as const)("resolves reported %s on a %s system to %s", (reported, system, expected) => {
    expect(resolveDesktopLocale(reported, system)).toBe(expected);
  });

  it("starts in the saved language, ignoring a saved value that is not a language tag", () => {
    expect(startDesktopLocale("zh-HK", "en-US")).toBe("zh-CN");
    expect(t("Check for Updates…")).toBe("检查更新…");
    expect(t("BotCamp {version} is ready to install.", { version: "1.2.0" })).toBe(
      "BotCamp 1.2.0 已可安装。",
    );
    expect(desktopMessages()).toBe(ZH_CN_MESSAGES);

    expect(startDesktopLocale("zh; rm -rf /", "en-US")).toBe("en");
    expect(t("Check for Updates…")).toBe("Check for Updates…");
    expect(desktopMessages()).toEqual({});
  });

  it("saves a language the app window reports and rebuilds the menus when it changes", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi.fn(async () => undefined);
    const onChange = vi.fn();
    const handle = createLocaleHandler(() => target, save, onChange);

    await handle(event, "zh-CN");
    expect(desktopLocale()).toBe("zh-CN");
    expect(save).toHaveBeenLastCalledWith("zh-CN");
    expect(onChange).toHaveBeenCalledTimes(1);

    // Traditional Chinese is still Simplified Chinese: saved for the next launch, menus unchanged.
    await handle(event, "zh-HK");
    expect(save).toHaveBeenLastCalledWith("zh-HK");
    expect(onChange).toHaveBeenCalledTimes(1);

    // Every launch reports again; an unchanged language writes nothing.
    await handle(event, "zh-HK");
    expect(save).toHaveBeenCalledTimes(2);

    await handle(event, "it");
    expect(desktopLocale()).toBe("en");
    expect(save).toHaveBeenLastCalledWith("it");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("refuses reports from other windows, subframes, origins and non-tags", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi.fn(async () => undefined);
    const onChange = vi.fn();
    const handle = createLocaleHandler(() => target, save, onChange);

    await handle({ ...event, sender: {} as WebContents }, "zh-CN");
    await handle(
      { ...event, senderFrame: { url: target.url } as IpcMainInvokeEvent["senderFrame"] },
      "zh-CN",
    );
    await handle(appFrame("https://other.example.com").event, "zh-CN");
    await createLocaleHandler(() => null, save, onChange)(event, "zh-CN");
    for (const value of [3, null, {}, "", "e", "es-", "../es", "es\nde", "x".repeat(36), "es;de"])
      await handle(event, value);

    expect(save).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(desktopLocale()).toBe("en");
  });

  it("keeps error messages English for reports and shows their translated detail", () => {
    startDesktopLocale("zh-CN", undefined);
    const error = withDetail(new Error("Page failed to load."), t("Page failed to load."));
    expect(error.message).toBe("Page failed to load.");
    expect(errorDetail(error)).toBe(ZH_CN_MESSAGES["Page failed to load."]);
    expect(errorDetail(new Error("plain"))).toBeUndefined();
    expect(errorDetail(null)).toBeUndefined();
  });

  it("keeps the last report when an earlier save finishes later", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const saved: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi.fn(async (locale: string) => {
      if (locale === "zh-CN") await firstWrite;
      saved.push(locale);
    });
    const handle = createLocaleHandler(
      () => target,
      save,
      () => undefined,
    );

    const first = handle(event, "zh-CN");
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith("zh-CN"));
    const second = handle(event, "en");
    releaseFirst();
    await Promise.all([first, second]);

    expect(saved).toEqual(["zh-CN", "en"]);
    expect(desktopLocale()).toBe("en");
  });

  it("saves the same language again after a failed save", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi
      .fn(async (_locale: string) => undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    const handle = createLocaleHandler(
      () => target,
      save,
      () => undefined,
    );

    await handle(event, "zh-CN");
    await handle(event, "zh-CN");

    expect(save).toHaveBeenCalledTimes(2);
  });

  it("skips writing a report a later one already replaced", async () => {
    startDesktopLocale(null, "en-US");
    const { event, target } = appFrame();
    const save = vi.fn(async (_locale: string) => undefined);
    const handle = createLocaleHandler(
      () => target,
      save,
      () => undefined,
    );

    await Promise.all(["zh-CN", "en", "zh-CN", "en"].map((locale) => handle(event, locale)));

    expect(save).not.toHaveBeenCalledWith("zh-CN");
    expect(save).toHaveBeenLastCalledWith("en");
  });

  it("opens the next launch in the language the app window last reported", async () => {
    const userData = await mkdtemp(path.join(tmpdir(), "rakazo-locale-"));
    try {
      await expect(readUiLocale(userData)).resolves.toBeNull();
      const { event, target } = appFrame();
      const handle = createLocaleHandler(
        () => target,
        (locale) => writeUiLocale(userData, locale),
        () => undefined,
      );
      startDesktopLocale(await readUiLocale(userData), "en-US");
      await handle(event, "zh-HK");

      startDesktopLocale(null, "en-US");
      expect(startDesktopLocale(await readUiLocale(userData), "en-US")).toBe("zh-CN");
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});

describe.each(Object.entries(CATALOGS))(
  "%s catalog",
  (_locale, catalog: Readonly<Record<string, string>>) => {
    it("keeps every placeholder and leaves no entry empty", () => {
      const empty = Object.entries(catalog).filter(([, value]) => !value.trim());
      const mismatched = Object.entries(catalog).filter(
        ([id, value]) => JSON.stringify(placeholders(id)) !== JSON.stringify(placeholders(value)),
      );
      expect(empty).toEqual([]);
      expect(mismatched).toEqual([]);
    });

    it("translates every desktop t() id, and nothing else", () => {
      const ids = new Set<string>();
      for (const file of readdirSync(srcDir)) {
        if (!/\.(ts|js|cjs)$/.test(file) || file.endsWith(".test.ts")) continue;
        for (const id of translationIds(readFileSync(path.join(srcDir, file), "utf8"))) ids.add(id);
      }
      const missing = [...ids].filter((id) => !catalog[id]?.trim()).sort();
      const unused = Object.keys(catalog)
        .filter((id) => !ids.has(id))
        .sort();
      expect(missing).toEqual([]);
      expect(unused).toEqual([]);
    });
  },
);
