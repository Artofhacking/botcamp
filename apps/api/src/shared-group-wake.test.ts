import { describe, expect, it } from "vitest";
import { capSharedGroupTranscript, partitionSharedGroupBots } from "./shared-group-wake.js";

const ada = { botId: "ada", userId: "user-a", spaceId: "space-a", name: "Ada-Helper" };
const bee = { botId: "bee", userId: "user-b", spaceId: "space-b", name: "Bea-Helper" };

describe("shared group send targets", () => {
  it("keeps a private group's bots on the group thread", () => {
    expect(partitionSharedGroupBots(false, "space-a", [ada, bee], ["ada", "bee"])).toEqual({
      inThreadIds: ["ada", "bee"],
      foreign: [],
    });
  });

  it("wakes a bot from another space and runs a same-space bot in the group", () => {
    expect(partitionSharedGroupBots(true, "space-a", [ada, bee], ["ada", "bee"])).toEqual({
      inThreadIds: ["ada"],
      foreign: [bee],
    });
  });

  it("keeps the newest lines inside the transcript cap", () => {
    expect(capSharedGroupTranscript(["one", "two", "three"], 9)).toBe("two\nthree");
    expect(capSharedGroupTranscript(["abcdefghij"], 4)).toBe("ghij");
  });
});
