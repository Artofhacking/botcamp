import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacInstaller, macInstallerOf, macInstallerUrl } from "./mac-installer.js";

const IMAGE = new TextEncoder().encode("a disk image");
const DIGEST = createHash("sha512").update(IMAGE).digest("base64");
const FILE = { url: "BotCamp-0.7.6-arm64.dmg", sha512: DIGEST, size: IMAGE.byteLength };
const FEED = "https://example.com/downloads/";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "botcamp-mac-installer-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("macInstallerOf", () => {
  it("picks the disk image out of a release that also publishes the zip", () => {
    expect(
      macInstallerOf([{ url: "BotCamp-0.7.6-arm64-mac.zip", sha512: DIGEST, size: 1 }, FILE]),
    ).toEqual(FILE);
  });

  it("refuses a name that is not a plain disk image in the downloads directory", () => {
    expect(macInstallerOf([{ ...FILE, url: "../BotCamp.dmg" }])).toBeNull();
    expect(macInstallerOf([{ ...FILE, url: "BotCamp.zip" }])).toBeNull();
    expect(macInstallerOf([{ ...FILE, sha512: "not-a-digest" }])).toBeNull();
  });

  it("has nothing to offer when the feed publishes no disk image", () => {
    expect(macInstallerOf(null)).toBeNull();
    expect(macInstallerOf([])).toBeNull();
  });
});

describe("macInstallerUrl", () => {
  it("resolves the published name against the feed, with or without a trailing slash", () => {
    expect(macInstallerUrl(FEED, FILE.url)).toBe(`${FEED}${FILE.url}`);
    expect(macInstallerUrl("https://example.com/downloads", FILE.url)).toBe(`${FEED}${FILE.url}`);
  });
});

describe("MacInstaller", () => {
  it("streams the image to disk and reports the finished percentage", async () => {
    const installer = new MacInstaller({
      dir,
      fetch: async () => new Response(IMAGE),
      open: async () => "",
    });
    const progress: number[] = [];

    const file = await installer.download(`${FEED}${FILE.url}`, FILE, (percent) => {
      progress.push(percent);
    });

    expect(path.basename(file)).toBe(FILE.url);
    expect(await readFile(file)).toEqual(Buffer.from(IMAGE));
    expect(progress.at(-1)).toBe(100);
  });

  it("keeps nothing when the bytes do not match the published checksum", async () => {
    const tampered = Buffer.from(IMAGE);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const installer = new MacInstaller({
      dir,
      fetch: async () => new Response(tampered),
      open: async () => "",
    });

    await expect(installer.download(`${FEED}${FILE.url}`, FILE, () => undefined)).rejects.toThrow(
      "does not match its published checksum",
    );
    await expect(readFile(path.join(dir, FILE.url))).rejects.toThrow();
  });

  it("reuses a complete download instead of fetching it again", async () => {
    const fetch = vi.fn(async () => new Response(IMAGE));
    const installer = new MacInstaller({ dir, fetch, open: async () => "" });
    await installer.download(`${FEED}${FILE.url}`, FILE, () => undefined);
    fetch.mockClear();

    await installer.download(`${FEED}${FILE.url}`, FILE, () => undefined);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the message the shell reports instead of claiming it opened", async () => {
    const installer = new MacInstaller({
      dir,
      fetch: async () => new Response(IMAGE),
      open: async () => "no application knows how to open this file",
    });

    await expect(installer.open(path.join(dir, FILE.url))).rejects.toThrow(
      "no application knows how to open this file",
    );
  });
});
