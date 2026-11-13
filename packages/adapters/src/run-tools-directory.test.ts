import { describe, expect, it } from "vitest";
import { directoryToolDescription } from "./run-tools-directory.js";

describe("directory tool descriptions", () => {
  it("names the connected account and the commands that read it", () => {
    const read = directoryToolDescription("directory_read", "飞书");
    expect(read).toContain("connected 飞书 account");
    expect(read).toContain('"im","+chat-list"');
    expect(read).toContain('"im","+chat-messages-list"');
    expect(read).toContain('"docs","+search"');
  });

  it("describes a write as the same person with approval", () => {
    const write = directoryToolDescription("directory_write", "Lark");
    expect(write).toContain("connected Lark account");
    expect(write).toContain("approves each call");
    expect(write).toContain("runs as that person");
  });
});
