import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { prepareDirectoryCliArgs, runDirectoryCli } from "./directory-cli.js";

afterEach(() => {
  spawn.mockReset();
  delete process.env.LARK_LOGIN_APP_SECRET;
});

describe("directory command arguments", () => {
  it("keeps a read and runs it as the signed-in person", () => {
    expect(prepareDirectoryCliArgs(["calendar", "+agenda"])).toEqual({
      argv: ["calendar", "+agenda", "--as", "user"],
      effect: "read",
    });
    expect(
      prepareDirectoryCliArgs(["api", "GET", "/open-apis/calendar/v4/calendars"]),
    ).toMatchObject({
      effect: "read",
    });
  });

  it("treats changes and unknown commands as writes, and blocks identity changes", () => {
    expect(prepareDirectoryCliArgs(["calendar", "+create"])).toMatchObject({ effect: "write" });
    expect(prepareDirectoryCliArgs(["docs", "+mystery"])).toMatchObject({ effect: "write" });
    expect(prepareDirectoryCliArgs(["api", "POST", "/open-apis/x"])).toMatchObject({
      effect: "write",
    });
    expect(prepareDirectoryCliArgs(["api", "GET", "/open-apis/x", "--data", "{}"])).toMatchObject({
      effect: "write",
    });
    expect(prepareDirectoryCliArgs(["auth", "login"])).toEqual({
      error: "That directory command is not available.",
    });
    expect(prepareDirectoryCliArgs(["calendar", "+agenda", "--as", "bot"])).toEqual({
      error: "The directory command runs only as the signed-in person.",
    });
    expect(prepareDirectoryCliArgs(["calendar", "+agenda", "--client-secret", "x"])).toEqual({
      error: "That directory command is not available.",
    });
  });
});

describe("directory command process", () => {
  it("passes the user token and not the login secret", async () => {
    process.env.LARK_LOGIN_APP_SECRET = "login-secret";
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("ok"));
        child.emit("close", 0);
      });
      return child;
    });
    await expect(
      runDirectoryCli({
        appId: "cli-test",
        accessToken: "user-token",
        brand: "feishu",
        argv: ["calendar", "+agenda", "--as", "user"],
      }),
    ).resolves.toEqual({ exitCode: 0, output: "ok", truncated: false });
    const env = spawn.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("user-token");
    expect(env.LARKSUITE_CLI_APP_ID).toBe("cli-test");
    expect(env.LARKSUITE_CLI_BRAND).toBe("feishu");
    expect(JSON.stringify(env)).not.toContain("login-secret");
    expect(spawn.mock.calls[0]?.[2]?.shell).toBe(false);
  });
});
