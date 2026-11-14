import { describe, expect, it } from "vitest";
import { isOwnUserMessage } from "./chat-shared";

describe("isOwnUserMessage", () => {
  it("treats a stamped message as yours only when you sent it", () => {
    expect(isOwnUserMessage({ role: "user", senderUserId: "me" }, "me")).toBe(true);
    expect(isOwnUserMessage({ role: "user", senderUserId: "other" }, "me")).toBe(false);
  });

  it("still owns a user message from a chat with one person", () => {
    expect(isOwnUserMessage({ role: "user" }, "me")).toBe(true);
  });

  it("never owns a bot message", () => {
    expect(isOwnUserMessage({ role: "bot" }, "me")).toBe(false);
  });
});
