import { describe, expect, it } from "vitest";
import { matchUiLocale } from "./ui-locale.js";

const SHIPPED = ["en", "zh-CN"] as const;

describe("matchUiLocale", () => {
  it("maps any Chinese tag to Simplified Chinese", () => {
    for (const tag of [
      "zh",
      "zh-CN",
      "zh-Hans",
      "zh-Hans-CN",
      "zh-Hans-TW",
      "zh-TW",
      "zh-HK",
      "zh-MO",
      "zh-Hant",
      "zh-Hant-HK",
      "zh_Hans_CN",
      "zh-SG",
      " ZH-tw ",
      "zh-Hant-MY-u-ca-chinese",
      "zh-HK-u-ca-chinese",
      "zh-TW-x-hans",
    ]) {
      expect(matchUiLocale(tag, SHIPPED), tag).toBe("zh-CN");
    }
  });

  it("keeps English and uses English for every other language", () => {
    expect(matchUiLocale("en-US", SHIPPED)).toBe("en");
    expect(matchUiLocale("en-TW", SHIPPED)).toBe("en");
    for (const tag of ["de-DE", "es-419", "pt-BR", "ja", "he", "iw-IL", "sv-SE", "", null]) {
      expect(matchUiLocale(tag, SHIPPED), String(tag)).toBe("en");
    }
  });

  it("uses a language a surface still lists, and English when that surface does not", () => {
    expect(matchUiLocale("de-DE", ["en", "de"])).toBe("de");
    expect(matchUiLocale("es-419", ["en", "es"])).toBe("es");
    expect(matchUiLocale("de-DE", SHIPPED)).toBe("en");
    expect(matchUiLocale("zh-TW", ["en", "de"])).toBe("en");
  });
});
