import { describe, expect, it } from "vitest";
import { directoryClause } from "./run-instructions.js";

describe("directory instructions", () => {
  it("names the connected account and the commands that read it", () => {
    const clause = directoryClause({ name: "飞书", connected: true }) ?? "";
    expect(clause).toContain("The 飞书 account is connected.");
    expect(clause).toContain('"im","+chat-list"');
    expect(clause).toContain('"im","+chat-messages-list"');
    expect(clause).toContain('"docs","+search"');
    expect(clause).toContain("directory_read");
    expect(clause).toContain("directory_write");
  });

  it("tells the user where to connect an account that is not linked", () => {
    const clause = directoryClause({ name: "Lark", connected: false }) ?? "";
    expect(clause).toContain("connect Lark under Connect apps");
    expect(clause).toContain("Do not say Lark is unsupported.");
  });

  it("says nothing when the deployment has no directory", () => {
    expect(directoryClause(undefined)).toBeUndefined();
  });
});
