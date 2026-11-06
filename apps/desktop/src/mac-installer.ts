import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

/**
 * An unsigned macOS build cannot replace itself. The updater hands the final swap to Squirrel,
 * which checks that the download is signed by the same identity as the running app; ad-hoc
 * signing seals every build under its own hash, so the check fails and `quitAndInstall()` quietly
 * does nothing. The update therefore delivers the disk image a first install uses, and the person
 * drags it in. Checking, downloading and verifying are the same work either way.
 */
export interface MacInstallerFile {
  url: string;
  sha512: string;
  size: number;
}

const INSTALLER = /^[A-Za-z0-9][A-Za-z0-9._-]*\.dmg$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
/** A stalled transfer must not hold the updater open until the app quits. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function asInstaller(value: unknown): MacInstallerFile | null {
  if (typeof value !== "object" || value === null) return null;
  const { url, sha512, size } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof sha512 !== "string" || typeof size !== "number")
    return null;
  // The feed decides this name, and it becomes a path, so only a plain disk image is accepted.
  if (!INSTALLER.test(url) || !SHA512_BASE64.test(sha512)) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  return { url, sha512, size };
}

/** The disk image among a release's published files, or null when the feed ships only the zip. */
export function macInstallerOf(files: unknown): MacInstallerFile | null {
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    const parsed = asInstaller(file);
    if (parsed !== null) return parsed;
  }
  return null;
}

export function macInstallerUrl(feedUrl: string, file: string): string {
  return new URL(file, feedUrl.endsWith("/") ? feedUrl : `${feedUrl}/`).toString();
}

export interface MacInstallerDeps {
  /** Where the disk image waits between the download and the person's drag. */
  dir: string;
  fetch: (url: string, signal: AbortSignal) => Promise<Response>;
  /** `shell.openPath`, which reports a failure as its returned message rather than by throwing. */
  open: (file: string) => Promise<string>;
}

export class MacInstaller {
  constructor(private readonly deps: MacInstallerDeps) {}

  /**
   * Streams the disk image to disk and refuses to hand it over unless the bytes match the
   * published checksum. A later check reuses the file rather than downloading it again.
   */
  async download(
    url: string,
    expected: Pick<MacInstallerFile, "sha512" | "size">,
    onProgress: (percent: number) => void,
  ): Promise<string> {
    const name = path.posix.basename(new URL(url).pathname);
    if (!INSTALLER.test(name)) throw new Error("The update is not a disk image.");
    await mkdir(this.deps.dir, { recursive: true });
    const target = path.join(this.deps.dir, name);
    await this.prune(target);
    if (await this.matches(target, expected)) {
      onProgress(100);
      return target;
    }

    const partial = `${target}.part`;
    await rm(partial, { force: true });
    const response = await this.deps.fetch(url, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    const body = response.body;
    if (!response.ok || body === null) {
      await body?.cancel();
      throw new Error(`The update download failed with status ${response.status}.`);
    }

    const reader = body.getReader();
    const hash = createHash("sha512");
    const out = createWriteStream(partial);
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > expected.size) {
          throw new Error("The update download is larger than published.");
        }
        hash.update(value);
        if (!out.write(value)) await once(out, "drain");
        onProgress(Math.min(99, Math.round((received / expected.size) * 100)));
      }
      out.end();
      await finished(out);
    } catch (error) {
      out.destroy();
      await reader.cancel().catch(() => undefined);
      await rm(partial, { force: true });
      throw error;
    }

    if (received !== expected.size) {
      await rm(partial, { force: true });
      throw new Error("The update download is incomplete.");
    }
    if (hash.digest("base64") !== expected.sha512) {
      await rm(partial, { force: true });
      throw new Error("The update download does not match its published checksum.");
    }
    await rm(target, { force: true });
    await rename(partial, target);
    onProgress(100);
    return target;
  }

  async open(file: string): Promise<void> {
    const failure = await this.deps.open(file);
    if (failure !== "") throw new Error(failure);
  }

  /** A build the person left uninstalled would otherwise keep every version it downloaded. */
  private async prune(keep: string) {
    const entries = await readdir(this.deps.dir).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry !== path.basename(keep))
        .filter((entry) => entry.endsWith(".dmg") || entry.endsWith(".part"))
        .map((entry) => rm(path.join(this.deps.dir, entry), { force: true })),
    );
  }

  /** An earlier attempt that survived: same size and checksum, so the transfer can be skipped. */
  private async matches(file: string, expected: Pick<MacInstallerFile, "sha512" | "size">) {
    try {
      if ((await stat(file)).size !== expected.size) return false;
    } catch {
      return false;
    }
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("base64") === expected.sha512;
  }
}
