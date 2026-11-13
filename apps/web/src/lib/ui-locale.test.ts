import { describe, expect, it } from "vitest";
import {
  normalizeUiLocale,
  persistUiLocale,
  resolveUiLocale,
  UI_LOCALE_CHOICES,
  UI_LOCALE_STORAGE_KEY,
} from "./ui-locale";

describe("language choices", () => {
  it("offers only Simplified Chinese and English", () => {
    expect(UI_LOCALE_CHOICES).toEqual(["zh-CN", "en"]);
  });
});

describe("normalizeUiLocale", () => {
  it("keeps English and Simplified Chinese", () => {
    expect(normalizeUiLocale("en")).toBe("en");
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("en-TW")).toBe("en");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-TW")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_cn")).toBe("zh-CN");
    expect(normalizeUiLocale(" ZH-cn ")).toBe("zh-CN");
  });

  it.each([
    "zh-TW",
    "zh_TW",
    " ZH-tw ",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
    "zh-TW-u-nu-hanidec",
    "zh-Hant-CN",
  ])("maps %s to Simplified Chinese", (tag) => expect(normalizeUiLocale(tag)).toBe("zh-CN"));

  it("uses English for every other language", () => {
    for (const tag of ["de-DE", "ko-KR", "pt-BR", "es-MX", "ja-JP", "he", "iw-IL", "sv-SE", ""]) {
      expect(normalizeUiLocale(tag)).toBe("en");
    }
    expect(normalizeUiLocale(null)).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  it("prefers the saved choice over env and navigator", () => {
    expect(
      resolveUiLocale({
        stored: "zh-CN",
        envDefault: "de",
        navigatorLanguage: "en-US",
      }),
    ).toBe("zh-CN");
  });

  it("uses VITE_DEFAULT_UI_LOCALE when nothing is saved", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: "zh-Hans-SG",
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("zh-CN");
  });

  it("uses navigator.language next, then English", () => {
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "ko-KR",
      }),
    ).toBe("en");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: "zh-CN",
      }),
    ).toBe("zh-CN");
    expect(
      resolveUiLocale({
        stored: null,
        envDefault: null,
        navigatorLanguage: null,
      }),
    ).toBe("en");
  });

  it("reads localStorage via the storage helper", () => {
    const storage = {
      getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "zh-HK" : null),
    };
    expect(resolveUiLocale({ storage, envDefault: null, navigatorLanguage: null })).toBe("zh-CN");
  });
});

describe("persistUiLocale", () => {
  it("writes the storage key", () => {
    const store = new Map<string, string>();
    persistUiLocale("en", {
      setItem: (key, value) => {
        store.set(key, value);
      },
    });
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("en");
  });
});

describe("Chinese preferences", () => {
  it("uses Simplified Chinese for a Chinese device, and lets a saved choice override it", () => {
    expect(resolveUiLocale({ stored: null, envDefault: null, navigatorLanguage: "zh-TW" })).toBe(
      "zh-CN",
    );
    expect(resolveUiLocale({ stored: "en", envDefault: "zh-TW", navigatorLanguage: "zh-CN" })).toBe(
      "en",
    );
    expect(resolveUiLocale({ stored: "zh-CN", envDefault: "en", navigatorLanguage: "en" })).toBe(
      "zh-CN",
    );
    expect(resolveUiLocale({ stored: null, envDefault: "zh-TW", navigatorLanguage: "en" })).toBe(
      "zh-CN",
    );
  });
});
