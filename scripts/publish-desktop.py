#!/usr/bin/env python3
"""Publish desktop installers to the object storage behind the update feed.

electron-builder already writes everything the feed needs. Cutting a release by hand means
copying those files somewhere and hoping the manifest went with them; a missing piece shows
up as an update that checks, downloads, and then does nothing. This uploads the whole set
and then confirms the public address really serves it.

    COS_SECRET_ID, COS_SECRET_KEY   credentials, stored as repository secrets
    COS_BUCKET, COS_REGION          where the feed lives, stored as repository variables

    python scripts/publish-desktop.py --version 0.7.6 --platform mac

Every name electron-builder writes carries the version, so a release never overwrites the
one before it; only the manifest is a fixed name, and that one is uploaded last.
"""

from __future__ import annotations

import argparse
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULTS = {
    "out": "apps/desktop/out",
    "platform": "mac",
    "prefix": "botcamp/updates/desktop",
    "base": "https://camp.aigc.sx.cn/botcamp/updates/desktop/",
    "bucket": "botcamp-1307257815",
    "region": "ap-guangzhou",
}

# What each platform publishes. electron-builder names the manifest after the target.
# The Mac manifest names the zip. The app installs that zip on restart, and the disk image
# is the first download an older build still opens.
ARTIFACTS = {
    "mac": {
        "suffixes": (".dmg", ".dmg.blockmap", ".zip", ".zip.blockmap"),
        "feed": "latest-mac.yml",
    },
    "win": {"suffixes": (".exe", ".exe.blockmap"), "feed": "latest.yml"},
}

CONTENT_TYPES = {
    ".blockmap": "application/octet-stream",
    ".dmg": "application/x-apple-diskimage",
    ".exe": "application/vnd.microsoft.portable-executable",
    ".yml": "text/yaml; charset=utf-8",
    ".zip": "application/zip",
}

# A version never changes after it ships, so its files can be cached hard. The manifest does
# change, and a cached copy is exactly how a release appears not to exist.
IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"


def fail(message: str) -> None:
    print(f"publish-desktop: {message}", file=sys.stderr)
    raise SystemExit(1)


def collect(out_dir: Path, platform: str, version: str) -> tuple[list[Path], str]:
    spec = ARTIFACTS[platform]
    feed = out_dir / spec["feed"]
    if not feed.is_file():
        fail(f"{spec['feed']} is missing from {out_dir}")

    files = [feed]
    for candidate in sorted(out_dir.iterdir()):
        if not candidate.is_file() or candidate == feed:
            continue
        if version not in candidate.name:
            continue
        if candidate.name.endswith(spec["suffixes"]):
            files.append(candidate)
    if len(files) == 1:
        fail(f"no {platform} installer for {version} in {out_dir}")

    manifest = feed.read_text(encoding="utf-8")
    if f"version: {version}" not in manifest:
        fail(f"{spec['feed']} does not describe {version}")
    return files, spec["feed"]


def content_type(name: str) -> str:
    for suffix, value in CONTENT_TYPES.items():
        if name.endswith(suffix):
            return value
    return "application/octet-stream"


def upload(files: list[Path], prefix: str) -> None:
    from qcloud_cos import CosConfig, CosS3Client

    secret_id = os.environ.get("COS_SECRET_ID")
    secret_key = os.environ.get("COS_SECRET_KEY")
    bucket = os.environ.get("COS_BUCKET") or DEFAULTS["bucket"]
    region = os.environ.get("COS_REGION") or DEFAULTS["region"]
    for name, value in (
        ("COS_SECRET_ID", secret_id),
        ("COS_SECRET_KEY", secret_key),
    ):
        if not value:
            fail(f"{name} is not set")

    client = CosS3Client(
        CosConfig(Region=region, SecretId=secret_id, SecretKey=secret_key, Scheme="https")
    )
    # The manifest goes last: until it lands, the feed still describes the previous release.
    ordered = sorted(files, key=lambda path: path.suffix in (".yml",))
    for path in ordered:
        key = f"{prefix}/{path.name}"
        cache = REVALIDATE if path.suffix == ".yml" else IMMUTABLE
        # Chunked and parallel: a single-request upload of a 150 MB installer crawls
        # across the Pacific and can outlast the step's own timeout.
        client.upload_file(
            Bucket=bucket,
            Key=key,
            LocalFilePath=str(path),
            PartSize=10,
            MAXThread=8,
            ContentType=content_type(path.name),
            CacheControl=cache,
        )
        print(f"uploaded {key} ({path.stat().st_size} bytes)")


def verify(base: str, files: list[Path]) -> None:
    for path in files:
        url = f"{base}{path.name}"
        request = urllib.request.Request(url, method="HEAD")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                served = int(response.headers.get("content-length") or 0)
        except urllib.error.HTTPError as error:
            fail(f"{url} returned {error.code} after upload")
        except urllib.error.URLError as error:
            fail(f"{url} is unreachable: {error.reason}")
        if served != path.stat().st_size:
            fail(f"{url} is {served} bytes, expected {path.stat().st_size}")
    print(f"verified {len(files)} files at {base}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=DEFAULTS["out"])
    parser.add_argument("--version", required=True)
    parser.add_argument("--platform", default=DEFAULTS["platform"], choices=sorted(ARTIFACTS))
    parser.add_argument("--prefix", default=DEFAULTS["prefix"])
    parser.add_argument("--base", default=DEFAULTS["base"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-verify", action="store_true")
    args = parser.parse_args()

    base = args.base if args.base.endswith("/") else f"{args.base}/"
    files, feed = collect(Path(args.out), args.platform, args.version)

    for path in sorted(files, key=lambda item: item.name):
        print(f"{'would upload' if args.dry_run else 'uploading'} {path.name} ({path.stat().st_size} bytes)")
    if args.dry_run:
        print(f"manifest: {feed}")
        return

    upload(files, args.prefix)
    if not args.no_verify:
        verify(base, files)
    print(f"published {args.platform} {args.version}")


if __name__ == "__main__":
    main()
