#!/bin/bash
# BotCamp 发布：/opt/botcamp/deploy.sh <app.py> <version>
set -euo pipefail
SRC=${1:?用法: deploy.sh <app.py> <version>}
VER=${2:?用法: deploy.sh <app.py> <version>}
ROOT=/opt/botcamp
REL="$ROOT/releases/$VER"
CUR=$(readlink -f "$ROOT/current" 2>/dev/null || true)

python3 -c "import ast,sys;ast.parse(open('$SRC').read())" || { echo "语法检查失败，未发布"; exit 1; }
mkdir -p "$REL"
cp "$SRC" "$REL/app.py"
echo "$VER" > "$REL/VERSION"

if [ -n "$CUR" ] && [ -d "$CUR" ]; then
  ln -sfn "$CUR" "$ROOT/previous"
fi
ln -sfn "$REL" "$ROOT/current"
systemctl restart botcamp
sleep 2

if curl -fsS --max-time 5 http://127.0.0.1:8790/botcamp/healthz | grep -q '"ok": *true'; then
  echo "发布成功: $VER (当前 -> $REL)"
else
  echo "健康检查失败，回滚"
  if [ -n "$CUR" ] && [ -d "$CUR" ]; then
    ln -sfn "$CUR" "$ROOT/current"
    systemctl restart botcamp
    sleep 2
    echo "已回滚到 $(cat "$CUR/VERSION" 2>/dev/null || echo unknown)"
  fi
  exit 1
fi
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
