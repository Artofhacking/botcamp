#!/usr/bin/env bash
# Build the DeepSeek Bot / BotCamp shell (app/ui) and publish static + authenticated bot function.
# MediaAccount workbench is an in-app Gate view (「自媒体账号」) after email/password login,
# served via POST /api/bot media/* CONTROL. Optional static copy also lands at /media/.
# Requires demox login or DEMOX_TOKEN. Does not print function env values.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/app/ui/dist"
META="$ROOT/demox-site.json"
NAME="${DEMOX_SITE_NAME:-botcamp-dsh-frontend}"
PROJECT_ID="${DEMOX_PROJECT_ID:-PQBDTM6GLZ}"

if [[ -n "${DEMOX_TOKEN:-}" && ! -f "${HOME}/.demox/token.json" ]]; then
  mkdir -p "${HOME}/.demox"
  python3 - <<'PY'
import json, os, time, base64
from pathlib import Path
token = os.environ["DEMOX_TOKEN"]
exp = None
try:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
except Exception:
    pass
expires_at = int(exp * 1000) if exp else int(time.time() * 1000 + 30 * 86400 * 1000)
Path.home().joinpath(".demox/token.json").write_text(json.dumps({
    "schemaVersion": 2,
    "accessToken": token,
    "refreshToken": token,
    "expiresAt": expires_at,
    "tokenType": "Bearer",
    "scopes": ["website:deploy", "website:list", "website:delete", "website:update"],
    "userId": "",
    "clientId": "demox-mcp-client",
}, indent=2))
PY
  chmod 600 "${HOME}/.demox/token.json"
fi

npm install --prefix "$ROOT"
npm run seed --prefix "$ROOT"
npm run test:isolation --prefix "$ROOT"
npm --prefix "$ROOT/app" ci
npm --prefix "$ROOT/app" test
npm --prefix "$ROOT/app" run build

# Optional: nest MediaAccount SPA under /media/ (shell at site root stays primary).
if [[ -d "$ROOT/web" ]]; then
  npm install --prefix "$ROOT/web"
  npm run build --prefix "$ROOT/web"
  rm -rf "$DIST/media"
  mkdir -p "$DIST/media"
  cp -a "$ROOT/web/dist/." "$DIST/media/"
fi

python3 - "$DIST/index.html" <<'PY'
import sys
from pathlib import Path
html = Path(sys.argv[1]).read_text()
if "location.replace" in html or "camp.aigc.sx.cn" in html:
    raise SystemExit("refusing to deploy: dist/index.html points the browser at camp")
print("dist/index.html stays on the Demox origin (BotCamp / DeepSeek Bot shell)")
PY

ID=""
if [[ -f "$META" ]]; then
  ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$META")"
  PROJECT_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("projectId") or "PQBDTM6GLZ")' "$META")"
fi

DEMOX=(npx --yes @demox-site/cli@1.1.6)
FN_SLUG="bot"
FN_ROUTES="/api/bot,/api/bot/feed"

if [[ -z "${DEMOX_TOKEN:-}" && ! -f "${HOME}/.demox/token.json" ]]; then
  echo "未登录 Demox（没有 DEMOX_TOKEN，也没有 ~/.demox/token.json）。已构建并测试，但没有发布。"
  exit 1
fi

DEPLOY_ARGS=(deploy "$DIST" --name "$NAME" --project "$PROJECT_ID")
if [[ -n "$ID" ]]; then
  echo "Updating Demox site $ID in project $PROJECT_ID (BotCamp shell + /media workbench)"
  DEPLOY_ARGS+=(--id "$ID")
else
  echo "Creating a Demox site in project $PROJECT_ID"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
LOG="$tmpdir/deploy.log"
"${DEMOX[@]}" "${DEPLOY_ARGS[@]}" | tee "$LOG"

python3 - <<PY
import json, re
from pathlib import Path
text = Path("$LOG").read_text()
meta_path = Path("$META")
existing = json.loads(meta_path.read_text()) if meta_path.exists() else {}
m_id = re.search(r"\bID:\s*([A-Z0-9]+)", text)
m_url = re.search(r"https://[a-z0-9.-]+\.demox\.site/?", text)
site_id = (m_id.group(1) if m_id else existing.get("id") or "$ID").strip()
url = (m_url.group(0) if m_url else existing.get("url") or "").strip()
if not url.endswith("/"):
    url += "/"
if not site_id or not url:
    raise SystemExit("could not parse Demox deploy output")
origin_host = url.rstrip("/").split("//", 1)[-1]
payload = dict(existing)
payload.update({
    "id": site_id,
    "name": "$NAME",
    "url": url if url.endswith("/") else url + "/",
    "origin_host": origin_host,
    "projectId": "$PROJECT_ID",
    "projectSlug": existing.get("projectSlug") or "botcamp",
    "projectName": existing.get("projectName") or "botcamp",
})
meta_path.write_text(json.dumps(payload, indent=2) + "\n")
print(f"Wrote {meta_path}: {site_id} -> {url}")
PY

ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$META")"
BUNDLE="$tmpdir/bot"
mkdir -p "$BUNDLE"
"$ROOT/app/node_modules/.bin/esbuild" "$ROOT/functions/bot/entry.mjs" \
  --bundle --platform=node --format=cjs --outfile="$BUNDLE/index.js"
echo "推送云函数 ${FN_SLUG}（含 media/* CONTROL；routes 仅创建时生效）: ${FN_ROUTES}"
FN_LOG="$tmpdir/fn.log"
attempt=1
delay=4
VERSION=""
while [[ $attempt -le 5 ]]; do
  echo "function push attempt $attempt"
  if "${DEMOX[@]}" functions push "$BUNDLE" --id "$ID" --slug "$FN_SLUG" --name bot --routes "$FN_ROUTES" | tee "$FN_LOG"; then
    VERSION="$(python3 - "$FN_LOG" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
match = re.search(r"版本:\s*(\d+)", text) or re.search(r"\bv(\d+)\b", text)
print(match.group(1) if match else "")
PY
)"
    [[ -n "$VERSION" ]] && break
  fi
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done
if [[ -z "$VERSION" ]]; then
  echo "云函数推送失败"
  exit 1
fi
echo "把 production 指到 v${VERSION}"
attempt=1
delay=4
while [[ $attempt -le 5 ]]; do
  if "${DEMOX[@]}" functions alias set --id "$ID" --slug "$FN_SLUG" production --version="$VERSION"; then
    break
  fi
  sleep "$delay"
  delay=$((delay * 2))
  attempt=$((attempt + 1))
done
echo "BotCamp 壳静态页 + media CONTROL 云函数已发布。自媒体入口在登录后左下角「自媒体账号」。"
echo "账号环境变量要用 demox env set 单独设置，不要写进仓库。"
echo "生产账本用 BOTCAMP_STORE=demox-project 和 BOTCAMP_PROJECT_ID，不要把 BOTCAMP_DATA_DIR 指到 /tmp。"
