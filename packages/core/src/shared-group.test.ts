import { describe, expect, it } from "vitest";
import {
  canAddSharedGroupBot,
  canInviteSharedGroupPerson,
  sharedGroupBotName,
  sharedGroupWakePrompt,
} from "./shared-group.js";

describe("shared group names", () => {
  it("joins the person's name and the bot's name", () => {
    expect(sharedGroupBotName("Ada", "Helper")).toBe("Ada-Helper");
    expect(sharedGroupBotName("  Ada   Lovelace ", " Helper ")).toBe("Ada Lovelace-Helper");
  });

  it("fills a missing name and keeps the label short", () => {
    expect(sharedGroupBotName("  ", "")).toBe("User-Bot");
    const label = sharedGroupBotName("A".repeat(80), "B".repeat(80));
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.startsWith("A")).toBe(true);
  });

  it("lets the creator and an admin add bots and invite people", () => {
    expect(canAddSharedGroupBot("owner")).toBe(true);
    expect(canAddSharedGroupBot("admin")).toBe(true);
    expect(canAddSharedGroupBot("member")).toBe(false);
    expect(canInviteSharedGroupPerson("admin")).toBe(true);
    expect(canInviteSharedGroupPerson("member")).toBe(false);
    expect(canInviteSharedGroupPerson(undefined)).toBe(false);
  });

  it("tells a woken bot the group name and not to reveal private memory", () => {
    const prompt = sharedGroupWakePrompt({
      groupName: "Launch",
      displayName: "Ada-Helper",
      transcript: "Ada: hi",
      senderLine: "Bo: status?",
    });
    expect(prompt).toContain('group "Launch"');
    expect(prompt).toContain("Ada-Helper");
    expect(prompt).toContain("Ada: hi");
    expect(prompt).toContain("Bo: status?");
    expect(prompt).toContain("private memory");
    expect(prompt).toContain("one name, the roster name");
    expect(prompt).toContain("Ada-Helper");
  });
});
