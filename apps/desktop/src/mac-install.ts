import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_BUNDLE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}\.app$/;

/**
 * Squirrel.Mac refuses an ad-hoc signature, and each unsigned build has a new one.
 * The feed's zip is already checksum-verified by the updater. This helper waits
 * until this process exits, swaps that app into place, and opens it.
 */
const SCRIPT = `#!/bin/bash
set -euo pipefail
bundle=$BOTCAMP_UPDATE_BUNDLE
zip=$BOTCAMP_UPDATE_ZIP
pid=$BOTCAMP_UPDATE_PID
deadline=$((SECONDS + 30))
while /bin/kill -0 "$pid" 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    exit 1
  fi
  /bin/sleep 0.2
done
/bin/sleep 0.3
work=$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/botcamp-update.XXXXXX")
trap '/bin/rm -rf "$work"' EXIT
/usr/bin/ditto -x -k "$zip" "$work"
name=$(/usr/bin/basename "$bundle")
app="$work/$name"
if [[ ! -d "$app/Contents/MacOS" ]]; then
  exit 1
fi
parent=$(/usr/bin/dirname "$bundle")
stage="$parent/.$name.incoming"
/bin/rm -rf "$stage"
/usr/bin/ditto "$app" "$stage"
/usr/bin/xattr -dr com.apple.quarantine "$stage" 2>/dev/null || true
backup="$parent/.$name.previous"
/bin/rm -rf "$backup"
if ! /bin/mv "$bundle" "$backup"; then
  /bin/rm -rf "$stage"
  exit 1
fi
if ! /bin/mv "$stage" "$bundle"; then
  /bin/mv "$backup" "$bundle" || true
  exit 1
fi
/bin/rm -rf "$backup"
if [[ "\${BOTCAMP_UPDATE_OPEN:-1}" == "1" ]]; then
  /usr/bin/open "$bundle" || true
fi
`;

/** The `.app` that contains this executable, or null when the path is not one. */
export function macAppBundle(execPath: string): string | null {
  const parts = execPath.replaceAll("\\", "/").split("/").filter((part) => part !== "");
  const contents = parts.lastIndexOf("Contents");
  if (contents < 1 || parts[contents + 1] !== "MacOS") return null;
  const bundle = `/${parts.slice(0, contents).join("/")}`;
  return APP_BUNDLE.test(path.posix.basename(bundle)) ? bundle : null;
}

function plainPath(value: string) {
  return value !== "" && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

export function installMacUpdate(input: {
  execPath: string;
  zipPath: string;
  pid: number;
  /** Tests set this so a stand-in bundle is not opened in Finder. */
  open?: boolean;
}) {
  const bundle = macAppBundle(input.execPath);
  if (
    bundle === null ||
    !plainPath(bundle) ||
    !plainPath(input.zipPath) ||
    !Number.isInteger(input.pid) ||
    input.pid <= 0
  ) {
    throw new Error("read-only volume");
  }
  const script = path.join(tmpdir(), `botcamp-update-${input.pid}.sh`);
  writeFileSync(script, SCRIPT, { mode: 0o700 });
  chmodSync(script, 0o700);
  const child = spawn("/bin/bash", [script], {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      BOTCAMP_UPDATE_BUNDLE: bundle,
      BOTCAMP_UPDATE_ZIP: input.zipPath,
      BOTCAMP_UPDATE_PID: String(input.pid),
      BOTCAMP_UPDATE_OPEN: input.open === false ? "0" : "1",
    },
  });
  child.unref();
}
