import { describe, expect, it } from "vitest";
import { AppLocaleSchema } from "./domain.js";

describe("AppLocaleSchema", () => {
  it("accepts the app's language codes and nothing else", () => {
    for (const locale of ["en", "zh-CN"]) {
      expect(AppLocaleSchema.safeParse(locale).success, locale).toBe(true);
    }
    for (const locale of [
      "xx",
      "zh-TW",
      "es",
      "de",
      "ja",
      "fil",
      "es-ES",
      "",
      "ES",
      "es_ES",
      "es-es",
      "es-ES-x-private",
      "<b>",
      "e".repeat(40),
    ]) {
      expect(AppLocaleSchema.safeParse(locale).success, locale).toBe(false);
    }
  });
});
