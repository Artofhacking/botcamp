#!/bin/bash
# 发布客户端更新到 COS + 生成 latest-mac.yml
# 用法: publish-update.sh <version> <artifact-dir>
set -euo pipefail
VER=${1:?用法: publish-update.sh <version> <artifact-dir>}
SRC=${2:?用法: publish-update.sh <version> <artifact-dir>}
ROOT=/opt/botcamp/updates/mac
BUCKET=demox-sites-1490780430
BASE="https://${BUCKET}.cos.ap-guangzhou.myqcloud.com/botcamp/updates/mac"
mkdir -p "$ROOT"

ZIP=$(ls -1 "$SRC"/*.zip 2>/dev/null | head -1 || true)
DMG=$(ls -1 "$SRC"/*.dmg 2>/dev/null | head -1 || true)
[ -n "$ZIP" ] || { echo "找不到 .zip 产物"; exit 1; }
ZIPNAME=$(basename "$ZIP")

python3 - "$ZIP" "botcamp/updates/mac/$ZIPNAME" <<'PY'
import os, sys
from qcloud_cos import CosConfig, CosS3Client
for line in open('/etc/botcamp/cos.env'):
    if '=' in line:
        k, v = line.strip().split('=', 1); os.environ[k] = v
cfg = CosConfig(Region='ap-guangzhou', SecretId=os.environ['SECRET_ID'], SecretKey=os.environ['SECRET_KEY'], Scheme='https')
cli = CosS3Client(cfg)
local, key = sys.argv[1], sys.argv[2]
with open(local, 'rb') as f:
    r = cli.put_object(Bucket=os.environ.get('BUCKET','demox-sites-1490780430'), Body=f, Key=key, EnableMD5=False)
print('uploaded', key, r.get('ETag'))
PY

SIZE=$(stat -c%s "$ZIP")
SHA=$(openssl dgst -sha512 -binary "$ZIP" | openssl base64 -A)
URL="$BASE/$ZIPNAME"
cat > "$ROOT/latest-mac.yml" <<YML
version: $VER
files:
  - url: $URL
    sha512: $SHA
    size: $SIZE
path: $URL
sha512: $SHA
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
YML

[ -n "$DMG" ] && echo "DMG 请单独上传: $DMG -> botcamp/downloads/mac/$(basename "$DMG")"
echo "已发布 $VER"; cat "$ROOT/latest-mac.yml"
