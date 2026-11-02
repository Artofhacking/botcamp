#!/usr/bin/env python3
"""Keep only the newest N BotCamp install packages in COS.

Usage:
  python3 prune-cos-releases.py [--keep 2] [--dry-run]

Credentials are read from SECRET_ID/SECRET_KEY/BUCKET/REGION when present
(the server's /etc/botcamp/cos.env layout), otherwise from ~/.cos.conf.
"""
import argparse
import configparser
import os
import re
import sys

from qcloud_cos import CosConfig, CosS3Client

PREFIXES = ("botcamp/updates/mac/", "botcamp/downloads/mac/")
PACKAGE_RE = re.compile(r"^BotCamp-(\d+\.\d+\.\d+)(?:-[^/]*)?\.(?:zip|dmg)$")


def credentials():
    if os.environ.get("SECRET_ID") and os.environ.get("SECRET_KEY"):
        return (
            os.environ["SECRET_ID"],
            os.environ["SECRET_KEY"],
            os.environ.get("BUCKET", "botcamp-1307257815"),
            os.environ.get("REGION", "ap-guangzhou"),
        )
    conf = configparser.ConfigParser()
    conf.read(os.path.expanduser("~/.cos.conf"))
    c = conf["common"]
    return c["secret_id"], c["secret_key"], c.get("bucket", "botcamp-1307257815"), c.get("region", "ap-guangzhou")


def list_objects(client, bucket, prefix):
    marker = ""
    while True:
        result = client.list_objects(Bucket=bucket, Prefix=prefix, Marker=marker, MaxKeys=1000)
        for item in result.get("Contents", []):
            yield item
        if result.get("IsTruncated") != "true":
            break
        marker = result["NextMarker"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.keep < 1:
        raise SystemExit("--keep must be >= 1")

    secret_id, secret_key, bucket, region = credentials()
    client = CosS3Client(CosConfig(Region=region, SecretId=secret_id, SecretKey=secret_key, Scheme="https"))

    packages = []
    for prefix in PREFIXES:
        for item in list_objects(client, bucket, prefix):
            name = item["Key"].rsplit("/", 1)[-1]
            match = PACKAGE_RE.match(name)
            if match is None:
                continue
            packages.append((match.group(1), item["Key"], item["Size"]))

    versions = sorted({item[0] for item in packages}, key=lambda value: tuple(int(part) for part in value.split(".")), reverse=True)
    keep_versions = set(versions[: args.keep])
    stale = [item for item in packages if item[0] not in keep_versions]

    print("keep versions:", ", ".join(sorted(keep_versions, key=lambda v: tuple(int(p) for p in v.split(".")), reverse=True)) or "(none)")
    if not stale:
        print("nothing to prune")
        return
    for version, key, size in stale:
        print(("would delete" if args.dry_run else "delete"), version, key, size)
        if not args.dry_run:
            client.delete_object(Bucket=bucket, Key=key)
    print(f"{'would prune' if args.dry_run else 'pruned'} {len(stale)} object(s)")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"prune failed: {exc}", file=sys.stderr)
        raise
