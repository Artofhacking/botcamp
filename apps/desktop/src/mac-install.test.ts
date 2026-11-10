import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installMacUpdate, macAppBundle } from "./mac-install.js";

const execFileAsync = promisify(execFile);

describe("macAppBundle", () => {
  it("finds the application that contains the executable", () => {
    expect(macAppBundle("/Applications/BotCamp.app/Contents/MacOS/BotCamp")).toBe(
      "/Applications/BotCamp.app",
    );
  });

  it("rejects an executable that is not inside an application bundle", () => {
    expect(macAppBundle("/usr/local/bin/botcamp")).toBeNull();
    expect(macAppBundle("/Applications/BotCamp.app/BotCamp")).toBeNull();
  });
});

describe.runIf(process.platform === "darwin")("installMacUpdate", () => {
  it("replaces the installed app with the one in the update zip", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "botcamp-mac-update-"));
    try {
      const bundle = path.join(root, "Applications", "BotCamp.app");
      const source = path.join(root, "source", "BotCamp.app");
      await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
      await mkdir(path.join(source, "Contents", "MacOS"), { recursive: true });
      const marker = path.join("Contents", "MacOS", "BotCamp");
      await writeFile(path.join(bundle, marker), "old");
      await writeFile(path.join(source, marker), "new");
      const zip = path.join(root, "update.zip");
      await execFileAsync("/usr/bin/ditto", ["-c", "-k", "--keepParent", source, zip]);
      installMacUpdate({
        execPath: path.join(bundle, "Contents", "MacOS", "BotCamp"),
        zipPath: zip,
        pid: 999_999,
        open: false,
      });
      await expect
        .poll(() => readFile(path.join(bundle, marker), "utf8").catch(() => ""))
        .toBe("new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
