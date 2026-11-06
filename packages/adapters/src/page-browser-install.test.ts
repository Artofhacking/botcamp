import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { shellQuote } from "./computer-support.js";
import {
  AGENT_BROWSER_SHA256,
  installAgentBrowserCommand,
  installPageBrowserFilesCommand,
  installUserPageBrowserCommand,
  pageBrowserFilesVersion,
  planPageBrowserInstall,
} from "./page-browser-install.js";

const computer = path.resolve(import.meta.dirname, "../../../infra/sandboxes/computer");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Runs a setup script with /usr/local moved under a scratch folder and no sudo. */
function runUnder(script: string, folder: string) {
  return execFileSync(
    "bash",
    ["-c", script.replaceAll("/usr/local", `${folder}/usr/local`).replaceAll('"sudo -n"', '""')],
    { encoding: "utf8" },
  );
}

it("writes this release's page-browser files once, and again when they differ", () => {
  root = mkdtempSync(path.join(tmpdir(), "page-browser-install-"));
  execFileSync("mkdir", ["-p", `${root}/usr/local/bin`]);
  const wrapper = `${root}/usr/local/bin/rakazo-page-browser`;
  const secrets = `${root}/usr/local/lib/rakazo/page_secrets.py`;

  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(wrapper, "utf8")).toBe(
    readFileSync(path.join(computer, "rakazo-page-browser"), "utf8"),
  );
  expect(readFileSync(secrets, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
  expect(statSync(wrapper).mode & 0o777).toBe(0o755);
  expect(statSync(secrets).mode & 0o777).toBe(0o644);

  // A computer already on this release keeps its files untouched.
  writeFileSync(secrets, "edited");
  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(secrets, "utf8")).toBe("edited");

  // One from another release gets this release's copy.
  writeFileSync(`${root}/usr/local/lib/rakazo/page-browser.version`, "older");
  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(secrets, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
});

it("installs the page browser into the home when the image is not writable", () => {
  root = mkdtempSync(path.join(tmpdir(), "page-browser-install-"));
  const command = installUserPageBrowserCommand();
  const marker = 'if [ "$(cat "$prefix/page-browser.version"';
  const files = [
    "set -eu",
    'prefix="${HOME:?}/.local/bin"',
    'mkdir -p "$prefix"',
    command.slice(command.indexOf(marker)),
  ].join("\n");
  execFileSync("bash", ["-c", files], { env: { ...process.env, HOME: root } });
  expect(readFileSync(`${root}/.local/bin/rakazo-page-browser`, "utf8")).toBe(
    readFileSync(path.join(computer, "rakazo-page-browser"), "utf8"),
  );
  expect(readFileSync(`${root}/.local/bin/page_secrets.py`, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
  expect(statSync(`${root}/.local/bin/rakazo-page-browser`).mode & 0o777).toBe(0o755);

  writeFileSync(`${root}/.local/bin/page_secrets.py`, "edited");
  execFileSync("bash", ["-c", files], { env: { ...process.env, HOME: root } });
  expect(readFileSync(`${root}/.local/bin/page_secrets.py`, "utf8")).toBe("edited");
});

it("keeps the pinned driver hashes beside the image install script", () => {
  const script = readFileSync(path.join(computer, "install-agent-browser.sh"), "utf8");
  expect(script).toContain(AGENT_BROWSER_SHA256.x64);
  expect(script).toContain(AGENT_BROWSER_SHA256.arm64);
});

it("skips the home install when the image already has the page browser", () => {
  expect(planPageBrowserInstall("image_ok\n", pageBrowserFilesVersion())).toEqual({
    action: "ready",
  });
  const current = [
    "image_missing",
    "x86_64",
    `${AGENT_BROWSER_SHA256.x64}  /home/rakazo/.local/bin/agent-browser`,
    pageBrowserFilesVersion(),
  ].join("\n");
  expect(planPageBrowserInstall(current, pageBrowserFilesVersion())).toEqual({ action: "ready" });
  expect(
    planPageBrowserInstall(
      ["image_missing", "aarch64", "missing", "missing"].join("\n"),
      pageBrowserFilesVersion(),
    ),
  ).toEqual({ action: "install", arch: "arm64", binary: true, files: true });
});

it("installs agent-browser with the computer image's pinned script", () => {
  expect(installAgentBrowserCommand()).toContain(
    shellQuote(readFileSync(path.join(computer, "install-agent-browser.sh"), "utf8")),
  );
});
