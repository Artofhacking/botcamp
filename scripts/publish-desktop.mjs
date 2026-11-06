import { spawn } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * Publishes desktop installers to the directory the update feed is served from.
 *
 * Cutting a release by hand means downloading an artifact, copying it onto the download host,
 * and editing latest.json; skipping any one leaves installed builds checking a feed that still
 * names the old version. This collects what electron-builder wrote, rewrites the download page's
 * entry for the platform, and copies the lot over SSH in one go.
 *
 *   node scripts/publish-desktop.mjs --version 0.7.6 --platform mac \
 *     --remote deploy@example.internal:/opt/botcamp/downloads \
 *     --ssh "ssh -i ~/.ssh/production -o BatchMode=yes"
 *
 * `--dry-run` prints what would be copied and the manifest it would write.
 */

const DEFAULTS = {
  out: "apps/desktop/out",
  platform: "mac",
  base: "https://botcamp.aigc.sx.cn/downloads/",
};

/** What each platform publishes; the version appears in every name electron-builder writes. */
const ARTIFACTS = {
  mac: {
    patterns: [/\.dmg$/, /\.dmg\.blockmap$/, /-mac\.zip$/, /-mac\.zip\.blockmap$/],
    feed: "latest-mac.yml",
  },
  win: { patterns: [/\.exe$/, /\.exe\.blockmap$/], feed: "latest.yml" },
};

const VERSION = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function fail(message) {
  console.error(`publish-desktop: ${message}`);
  process.exit(1);
}

/** The installer and its blockmap, plus the feed manifest that names them. */
async function collect(dir, platform, version) {
  const spec = ARTIFACTS[platform];
  const names = await readdir(dir);
  const matched = names.filter((name) => {
    if (name === spec.feed) return true;
    if (!spec.patterns.some((pattern) => pattern.test(name))) return false;
    return name.includes(version);
  });
  if (!matched.includes(spec.feed)) fail(`${spec.feed} is missing from ${dir}`);
  const installer = matched.find((name) => spec.patterns[0].test(name));
  if (installer === undefined) fail(`no ${platform} installer for ${version} in ${dir}`);
  return { names: matched, installer, feedPath: path.join(dir, spec.feed) };
}

/** The download page reads this; keep every field it already had, including Android's. */
async function nextManifest(base, platform, version, installer) {
  const current = await fetch(`${base}latest.json`, { cache: "no-store" });
  const published = current.ok ? await current.json() : {};
  const url = `${base}${installer}`;
  if (platform === "mac") return { ...published, mac: url, macVersion: version };
  return { ...published, windows: url, windowsVersion: version };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

/** One rsync copies every artifact with the permissions nginx needs to serve them. */
async function copy(remote, sshOptions, dir, names) {
  const args = ["-az", "--chmod=F644"];
  if (sshOptions !== undefined) args.push("-e", sshOptions);
  args.push(...names.map((name) => path.join(dir, name)), remote);
  await run("rsync", args);
}

/** A copy is only useful once the public address actually serves the new files. */
async function verify(base, names) {
  for (const name of names) {
    const response = await fetch(`${base}${name}`, { method: "HEAD" });
    if (!response.ok) fail(`${base}${name} returned ${response.status} after the copy`);
  }
}

const { values } = parseArgs({
  options: {
    out: { type: "string", default: DEFAULTS.out },
    version: { type: "string" },
    platform: { type: "string", default: DEFAULTS.platform },
    base: { type: "string", default: DEFAULTS.base },
    remote: { type: "string" },
    ssh: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (values.version === undefined || !VERSION.test(values.version)) {
  fail("--version must look like 0.7.6");
}
if (!Object.hasOwn(ARTIFACTS, values.platform)) fail("--platform must be mac or win");
if (!values["dry-run"] && values.remote === undefined)
  fail("--remote is required unless --dry-run");
const base = values.base.endsWith("/") ? values.base : `${values.base}/`;

const { names, installer, feedPath } = await collect(values.out, values.platform, values.version);
const feedText = await readFile(feedPath, "utf8");
if (!feedText.includes(`version: ${values.version}`)) {
  fail(`${path.basename(feedPath)} does not describe ${values.version}`);
}
const manifest = await nextManifest(base, values.platform, values.version, installer);
const manifestPath = path.join(values.out, "latest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const uploads = [...names, "latest.json"];

if (values["dry-run"]) {
  console.log(JSON.stringify(manifest, null, 2));
  for (const name of uploads) {
    const { size } = await stat(path.join(values.out, name));
    console.log(`would copy ${name} (${size} bytes)`);
  }
  process.exit(0);
}

await copy(values.remote, values.ssh, values.out, uploads);
for (const name of uploads) console.log(`copied ${name}`);
await verify(
  base,
  uploads.filter((name) => name !== "latest.json"),
);
console.log(`published ${values.platform} ${values.version} to ${base}`);
