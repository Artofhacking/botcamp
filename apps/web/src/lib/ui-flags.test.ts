// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { sectionHidden } from "./ui-flags";

afterEach(() => {
  delete window.__RAKAZO_UI__;
});

describe("sectionHidden", () => {
  it("hides only the sections the deployment names", () => {
    window.__RAKAZO_UI__ = { hiddenSections: ["billing"] };
    expect(sectionHidden("billing")).toBe(true);
    expect(sectionHidden("models")).toBe(false);
  });
});
