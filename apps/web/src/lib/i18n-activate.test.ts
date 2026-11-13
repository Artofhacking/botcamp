import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateUiLocale,
  getActiveUiLocale,
  i18n,
  setCatalogLoadersForTests,
  setUiLocale,
} from "./i18n";
import type { UiLocale } from "./ui-locale";
import { UI_LOCALE_STORAGE_KEY, UI_LOCALES } from "./ui-locale";

vi.mock("./apply-ui-direction", () => ({
  applyUiDirection: vi.fn(),
}));

function stubLocaleStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: () => null,
    length: 0,
  });
  return store;
}

const english = async () => ({ messages: { Settings: "Settings" } });

describe("activateUiLocale", () => {
  beforeEach(() => {
    setCatalogLoadersForTests(null);
    i18n.load("en", {});
    i18n.activate("en");
    vi.unstubAllGlobals();
  });

  it("falls back to English when the preferred catalog fails to load", async () => {
    setCatalogLoadersForTests({
      en: english,
      "zh-CN": async () => {
        throw new Error("zh-CN catalog missing");
      },
    });

    const locale = await activateUiLocale("zh-CN");
    expect(locale).toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("falls back to empty English when every catalog fails", async () => {
    setCatalogLoadersForTests({
      en: async () => {
        throw new Error("en missing");
      },
      "zh-CN": async () => {
        throw new Error("zh-CN missing");
      },
    });

    const locale = await activateUiLocale("zh-CN");
    expect(locale).toBe("en");
    expect(i18n.locale).toBe("en");
  });

  it("lets the latest locale selection win under concurrency", async () => {
    let resolveZh!: (value: { messages: Record<string, string> }) => void;
    const zhPromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveZh = resolve;
    });

    setCatalogLoadersForTests({
      en: english,
      "zh-CN": async () => zhPromise,
    });

    const first = activateUiLocale("zh-CN");
    const second = activateUiLocale("en");
    resolveZh({ messages: { Settings: "设置" } });

    await expect(first).resolves.toBe("en");
    await expect(second).resolves.toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("cancels a pending activation when re-selecting the already-active locale", async () => {
    let resolveZh!: (value: { messages: Record<string, string> }) => void;
    const zhPromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveZh = resolve;
    });

    setCatalogLoadersForTests({
      en: english,
      "zh-CN": async () => zhPromise,
    });

    await activateUiLocale("en");
    expect(getActiveUiLocale()).toBe("en");

    const pendingZh = activateUiLocale("zh-CN");
    const backToEn = activateUiLocale("en");
    resolveZh({ messages: { Settings: "设置" } });

    await expect(pendingZh).resolves.toBe("en");
    await expect(backToEn).resolves.toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(i18n.locale).toBe("en");
    expect(i18n._({ id: "Settings", message: "Settings" })).toBe("Settings");
  });

  it("does not let a stale setUiLocale fallback overwrite the latest stored locale", async () => {
    const store = stubLocaleStorage();
    let resolveZh!: (value: { messages: Record<string, string> }) => void;
    const zhPromise = new Promise<{ messages: Record<string, string> }>((resolve) => {
      resolveZh = resolve;
    });

    setCatalogLoadersForTests({
      en: english,
      "zh-CN": async () => zhPromise,
    });

    await activateUiLocale("en");
    const pendingZh = setUiLocale("zh-CN");
    const pendingEn = setUiLocale("en");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("en");

    resolveZh({ messages: { Settings: "设置" } });
    await expect(pendingZh).resolves.toBe("en");
    await expect(pendingEn).resolves.toBe("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("tells the desktop app the language it activated, even when the desktop refuses", async () => {
    const loaders = Object.fromEntries(
      UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
    ) as Record<UiLocale, () => Promise<{ messages: Record<string, string> }>>;
    setCatalogLoadersForTests(loaders);
    const set = vi.fn(async (_locale: string) => {
      throw new Error("refused");
    });
    vi.stubGlobal("window", { rakazoDesktop: { locale: { set } } });

    await expect(activateUiLocale("zh-CN")).resolves.toBe("zh-CN");
    expect(set).toHaveBeenCalledWith("zh-CN");

    // Older desktop releases have no locale bridge.
    vi.stubGlobal("window", { rakazoDesktop: {} });
    await expect(activateUiLocale("en")).resolves.toBe("en");
    vi.unstubAllGlobals();
  });
});
