#!/usr/bin/env python3
"""Give every Mach-O an ad-hoc signature without the hardened runtime flag."""

import os
import subprocess
from pathlib import Path

RC = "/tmp/apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign"
APP = Path("/tmp/dsh-official/extracted/DSH Desktop 2.0.18-universal/DSH Desktop.app")
MAGICS = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xce\xfa\xed\xfe"}


def identifier(path: Path) -> str:
    result = subprocess.run(
        [RC, "print-signature-info", str(path)],
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("identifier:"):
            return stripped.split(":", 1)[1].strip()
    return path.name


def main() -> None:
    files: list[Path] = []
    for dirpath, _dirnames, filenames in os.walk(APP):
        for name in filenames:
            path = Path(dirpath, name)
            if path.is_symlink():
                continue
            try:
                with path.open("rb") as handle:
                    magic = handle.read(4)
            except OSError:
                continue
            if magic in MAGICS:
                files.append(path)
    print(f"macho {len(files)}", flush=True)
    failed = 0
    for index, path in enumerate(files, 1):
        ident = identifier(path)
        temporary = path.with_name(path.name + ".hostsign")
        result = subprocess.run(
            [
                RC, "sign",
                "--code-signature-flags", "host",
                "--binary-identifier", ident,
                str(path),
                str(temporary),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not temporary.exists():
            failed += 1
            print(f"FAIL {path}\n{result.stderr[-500:]}", flush=True)
            temporary.unlink(missing_ok=True)
            continue
        os.chmod(temporary, path.stat().st_mode)
        os.replace(temporary, path)
        if index % 20 == 0 or index == len(files):
            print(f"signed {index}/{len(files)}", flush=True)
    if failed:
        raise SystemExit(f"{failed} binaries failed")
    print("machos signed", flush=True)


if __name__ == "__main__":
    main()
