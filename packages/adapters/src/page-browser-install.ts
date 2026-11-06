import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { shellQuote } from "./computer-support.js";

/** Keep these beside infra/sandboxes/computer/install-agent-browser.sh. */
export const AGENT_BROWSER_RELEASE = "0.41.0";
export const AGENT_BROWSER_SHA256 = {
  x64: "399c7e9f06bd29aa933fdf25c0bd958eea06927fc0ce6f536ba6347aabd64628",
  arm64: "e196e9cabe6cb1b01bd5912973628361b9f40a332683a12426abad007f0d3589",
} as const;

export type AgentBrowserArch = keyof typeof AGENT_BROWSER_SHA256;

/** The computer image's page-browser files: the API ships them in its source tree. */
const COMPUTER_DIR = path.join("infra", "sandboxes", "computer");

let computerDir: string | undefined;

function computerFile(name: string): string {
  if (!computerDir) {
    // Source, tests and the bundled server all sit somewhere below the repository root.
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, COMPUTER_DIR);
      if (existsSync(path.join(candidate, "rakazo-page-browser"))) {
        computerDir = candidate;
        break;
      }
      if (path.dirname(dir) === dir) throw new Error(`${COMPUTER_DIR} is missing`);
    }
  }
  return readFileSync(path.join(computerDir, name), "utf8");
}

const asRoot = 'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi';

/**
 * Installs the pinned agent-browser into /usr/local/bin with the computer image's own script.
 * It changes only when the pinned version does, so a provider's saved base image can carry it.
 */
export function installAgentBrowserCommand(): string {
  return [
    "set -eu",
    asRoot,
    `$root sh -c ${shellQuote(computerFile("install-agent-browser.sh"))} sh /usr/local/bin >/dev/null`,
  ].join("\n");
}

/**
 * Writes the page-browser wrapper and its secrets helper where the computer image keeps them,
 * from this release's copy, unless they already match it. Small enough to run on every boot,
 * so a hosted computer always runs the helper its API was released with.
 */
export function installPageBrowserFilesCommand(): string {
  const wrapper = computerFile("rakazo-page-browser");
  const secrets = computerFile("page_secrets.py");
  const version = createHash("sha256").update(wrapper).update("\0").update(secrets).digest("hex");
  // One archive, so both files change together.
  const archive = gzipSync(
    JSON.stringify({ "rakazo-page-browser": wrapper, "page_secrets.py": secrets }),
    { level: 9 },
  ).toString("base64");
  const unpack = [
    "import gzip, json, os, sys",
    "files = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "os.makedirs('/usr/local/lib/rakazo', exist_ok=True)",
    "for name, mode, target in (('page_secrets.py', 0o644, '/usr/local/lib/rakazo/page_secrets.py'),",
    "                           ('rakazo-page-browser', 0o755, '/usr/local/bin/rakazo-page-browser')):",
    "    with open(target + '.new', 'w', encoding='utf-8') as file:",
    "        file.write(files[name])",
    "    os.chmod(target + '.new', mode)",
    "    os.replace(target + '.new', target)",
    `open('/usr/local/lib/rakazo/page-browser.version', 'w').write(${JSON.stringify(version)})`,
  ].join("\n");
  return [
    "set -eu",
    `if [ "$(cat /usr/local/lib/rakazo/page-browser.version 2>/dev/null)" = ${version} ]; then exit 0; fi`,
    asRoot,
    `printf '%s' ${shellQuote(archive)} | base64 -d | $root python3 -c ${shellQuote(unpack)}`,
  ].join("\n");
}

/** Everything a hosted Linux computer needs for the page tools; idempotent and cheap once done. */
export function installPageBrowserCommand(): string {
  return [installAgentBrowserCommand(), installPageBrowserFilesCommand()]
    .map((script) => `( ${script}\n)`)
    .join(" && ");
}

function pageBrowserBundle() {
  const wrapper = computerFile("rakazo-page-browser");
  const secrets = computerFile("page_secrets.py");
  const version = createHash("sha256").update(wrapper).update("\0").update(secrets).digest("hex");
  const archive = gzipSync(
    JSON.stringify({ "rakazo-page-browser": wrapper, "page_secrets.py": secrets }),
    { level: 9 },
  ).toString("base64");
  return { version, archive };
}

/** Sha256 of the helper files this release would write into a computer. */
export function pageBrowserFilesVersion(): string {
  return pageBrowserBundle().version;
}

/**
 * Writes the helper under the computer user's home. A desktop image from before the page browser
 * has no root and no passwordless sudo, so the image copy cannot be written. The driver binary
 * arrives separately: that image also has no curl. The helper imports its sibling from its own directory.
 */
export function installUserPageBrowserCommand(): string {
  const { version, archive } = pageBrowserBundle();
  const unpack = [
    "import gzip, json, os, sys",
    'root = os.environ["HOME"] + "/.local/bin"',
    "os.makedirs(root, exist_ok=True)",
    "files = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "for name, mode in (('page_secrets.py', 0o644), ('rakazo-page-browser', 0o755)):",
    "    target = os.path.join(root, name)",
    "    with open(target + '.new', 'w', encoding='utf-8') as file:",
    "        file.write(files[name])",
    "    os.chmod(target + '.new', mode)",
    "    os.replace(target + '.new', target)",
    `open(os.path.join(root, "page-browser.version"), "w").write(${JSON.stringify(version)})`,
  ].join("\n");
  return [
    "set -eu",
    'export HOME="${HOME:-/home/rakazo}"',
    'prefix="${HOME:?}/.local/bin"',
    'mkdir -p "$prefix"',
    `if [ "$(cat "$prefix/page-browser.version" 2>/dev/null || true)" = ${version} ]; then exit 0; fi`,
    `printf '%s' ${shellQuote(archive)} | base64 -d | python3 -c ${shellQuote(unpack)}`,
  ].join("\n");
}

/** Reports whether the image or the home already has this release's page browser. */
export function pageBrowserProbeCommand(): string {
  return [
    "set -eu",
    'export HOME="${HOME:-/home/rakazo}"',
    'prefix="${HOME:?}/.local/bin"',
    'if [ -x /usr/local/bin/rakazo-page-browser ] && [ -x /usr/local/bin/agent-browser ]; then echo image_ok; exit 0; fi',
    "echo image_missing",
    "uname -m",
    'if [ -x "$prefix/agent-browser" ]; then sha256sum "$prefix/agent-browser"; else echo missing; fi',
    'if [ -f "$prefix/page-browser.version" ]; then cat "$prefix/page-browser.version"; else echo missing; fi',
  ].join("\n");
}

export function planPageBrowserInstall(probe: string, version: string) {
  const lines = probe.trim().split("\n");
  if (lines[0] === "image_ok") return { action: "ready" as const };
  if (lines[0] !== "image_missing" || lines.length < 4) {
    throw new Error("Page browser is not installed on this computer.");
  }
  const arch = agentBrowserArch(lines[1] ?? "");
  const have = lines[2] ?? "";
  const files = (lines[3] ?? "") === version;
  const binary = have.startsWith(`${AGENT_BROWSER_SHA256[arch]} `) || have.startsWith(`${AGENT_BROWSER_SHA256[arch]}\t`);
  if (binary && files) return { action: "ready" as const };
  return { action: "install" as const, arch, binary: !binary, files: !files };
}

function agentBrowserArch(machine: string): AgentBrowserArch {
  if (machine === "x86_64" || machine === "amd64") return "x64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  throw new Error("Page browser is not installed on this computer.");
}

/** Checks the driver on stdin and leaves it on the home PATH the helper already checks. */
export function installUserAgentBrowserCommand(arch: AgentBrowserArch): string {
  const sha256 = AGENT_BROWSER_SHA256[arch];
  return [
    "set -eu",
    'export HOME="${HOME:-/home/rakazo}"',
    'prefix="${HOME:?}/.local/bin"',
    'mkdir -p "$prefix"',
    'tmp="$prefix/agent-browser.new"',
    'cat > "$tmp"',
    `echo "${sha256}  $tmp" | sha256sum -c - >/dev/null`,
    'chmod 755 "$tmp"',
    'mv "$tmp" "$prefix/agent-browser"',
  ].join("\n");
}

/** The pinned driver, cached after the first download. The computer image is not asked to fetch it. */
export async function readAgentBrowserBinary(arch: AgentBrowserArch): Promise<Buffer> {
  const sha256 = AGENT_BROWSER_SHA256[arch];
  const cache = path.join(os.tmpdir(), `rakazo-agent-browser-${sha256}`);
  try {
    const cached = await readFile(cache);
    if (createHash("sha256").update(cached).digest("hex") === sha256) return cached;
  } catch {
    // The cache is missing or unreadable. Download the pinned release.
  }
  const response = await fetch(
    `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_RELEASE}/agent-browser-linux-${arch}`,
  );
  if (!response.ok) throw new Error("Page browser is not installed on this computer.");
  const binary = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(binary).digest("hex") !== sha256) {
    throw new Error("Page browser is not installed on this computer.");
  }
  await writeFile(cache, binary);
  return binary;
}
