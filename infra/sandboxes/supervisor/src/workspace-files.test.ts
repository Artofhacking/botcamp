import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listWorkspaceDirectoryArgv,
  parseWorkspaceDirectoryListing,
  readWorkspaceFileArgv,
  WORKSPACE_FILE_TOO_LARGE_EXIT,
  writeWorkspaceFileArgv,
} from "./supervisor-logic.js";

function run(argv: string[], input?: Buffer) {
  const [command, ...args] = argv;
  if (!command) throw new Error("empty argv");
  const result = spawnSync(command, args, { input, env: { PATH: "/usr/bin:/bin" } });
  return {
    code: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// The commands run inside the computer with GNU coreutils and findutils (Debian), not on macOS.
describe.skipIf(process.platform !== "linux")("workspace file commands", () => {
  it("writes stdin into a new directory and reads it back as base64", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-files-"));
    const target = path.join(root, "attachments", "photo.jpg");
    const bytes = Buffer.from([0, 255, 10, 13, 32, 1, 2, 3]);

    expect(run(writeWorkspaceFileArgv(target, false), bytes).code).toBe(0);
    expect(readFileSync(target)).toEqual(bytes);
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const read = run(readWorkspaceFileArgv(target, -1));
    expect(read.code).toBe(0);
    expect(Buffer.from(read.stdout, "base64")).toEqual(bytes);
    expect(run(readWorkspaceFileArgv(target, bytes.length)).code).toBe(0);
    expect(run(readWorkspaceFileArgv(target, bytes.length - 1)).code).toBe(
      WORKSPACE_FILE_TOO_LARGE_EXIT,
    );
    expect(run(readWorkspaceFileArgv(path.join(root, "missing"), -1)).code).not.toBe(0);
  });

  it("marks an executable write", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-files-"));
    const target = path.join(root, "run.sh");
    expect(run(writeWorkspaceFileArgv(target, true), Buffer.from("echo hi\n")).code).toBe(0);
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("lists one level without following symlinks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "workspace-files-"));
    mkdirSync(path.join(root, "notes"));
    writeFileSync(path.join(root, "b.txt"), "hello");
    writeFileSync(path.join(root, "tab\tname"), "");
    writeFileSync(path.join(root, "tool"), "#!/bin/sh\n");
    chmodSync(path.join(root, "tool"), 0o755);
    symlinkSync("/etc/passwd", path.join(root, "link"));

    const listed = run(listWorkspaceDirectoryArgv(root));
    expect(listed.code).toBe(0);
    expect(parseWorkspaceDirectoryListing(listed.stdout, "home")).toEqual([
      { path: "home/b.txt", kind: "file", size: 5 },
      { path: "home/notes", kind: "dir", size: expect.any(Number) },
      { path: "home/tab\tname", kind: "file", size: 0 },
      { path: "home/tool", kind: "file", size: 10, executable: true },
    ]);
    expect(run(listWorkspaceDirectoryArgv(path.join(root, "b.txt"))).code).not.toBe(0);
  });
});

describe("parseWorkspaceDirectoryListing", () => {
  it("joins the root without a leading slash", () => {
    expect(parseWorkspaceDirectoryListing("f\t3\t644\ta.txt\0", "")).toEqual([
      { path: "a.txt", kind: "file", size: 3 },
    ]);
  });
});
