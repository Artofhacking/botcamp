import { describe, expect, it } from "vitest";
import { BOT_SETTINGS_SECTIONS } from "./bot-settings-layout.js";

describe("bot settings layout", () => {
  it("assigns each control to one section", () => {
    const controls = Object.values(BOT_SETTINGS_SECTIONS).flat();
    expect(new Set(controls).size).toBe(controls.length);
  });
});
