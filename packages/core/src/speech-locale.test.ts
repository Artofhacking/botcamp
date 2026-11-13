import { describe, expect, it } from "vitest";
import { recognitionLocaleTag, speechLocaleTag, supportedSpeechTag } from "./speech-locale.js";

describe("speechLocaleTag", () => {
  it("maps an app locale to a tag the recognizer accepts", () => {
    expect(speechLocaleTag("en")).toBe("en-US");
    expect(speechLocaleTag("zh-CN")).toBe("zh-CN");
  });
});

describe("recognitionLocaleTag", () => {
  it("keeps the speaker's country when the UI is English", () => {
    expect(recognitionLocaleTag("en", "en-US-u-mu-celsius")).toBe("en-US");
    expect(recognitionLocaleTag("en", "EN-gb")).toBe("en-GB");
  });

  it("keeps Simplified Chinese over the speaker's region", () => {
    expect(recognitionLocaleTag("zh-CN", "zh-HK")).toBe("zh-CN");
    expect(recognitionLocaleTag("zh-CN", "zh-Hans-SG")).toBe("zh-CN");
  });

  it("follows the speaker whenever the UI is English", () => {
    expect(recognitionLocaleTag("en", "it-IT")).toBe("it-IT");
    expect(recognitionLocaleTag("en", "es-CL")).toBe("es-CL");
    expect(recognitionLocaleTag("en", "es-419")).toBe("es-MX");
    expect(recognitionLocaleTag("en", null)).toBe("en-US");
  });

  it("follows browser languages even when the app ships their catalogs", () => {
    expect(recognitionLocaleTag("en", "es-ES")).toBe("es-ES");
    expect(recognitionLocaleTag("en", "es-419")).toBe("es-MX");
    expect(recognitionLocaleTag("en", "ru-RU")).toBe("ru-RU");
    expect(recognitionLocaleTag("en", "es-CL")).toBe("es-CL");
  });
});

describe("supportedSpeechTag", () => {
  const apple = ["en-AE", "en-GB", "en-US", "es-419", "es-CL", "es-ES", "es-MX", "de-DE"];

  it("keeps a tag the recognizer lists", () => {
    expect(supportedSpeechTag("es-CL", apple)).toBe("es-CL");
    expect(supportedSpeechTag("en_GB", apple)).toBe("en-GB");
  });

  it("falls back to the app's region for the language, then to any region of it", () => {
    expect(supportedSpeechTag("es-AR", apple)).toBe("es-MX");
    expect(supportedSpeechTag("en-DE", apple)).toBe("en-US");
    expect(supportedSpeechTag("de-CH", apple)).toBe("de-DE");
    expect(supportedSpeechTag("es-PE", ["es-419", "es-ES"])).toBe("es-419");
  });

  it("keeps the tag when the recognizer lists nothing or nothing of its language", () => {
    expect(supportedSpeechTag("es-AR", [])).toBe("es-AR");
    expect(supportedSpeechTag("it-IT", apple)).toBe("it-IT");
  });
});
