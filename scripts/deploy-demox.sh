#!/usr/bin/env bash
# Build the DeepSeek Bot page and, when Demox is logged in, publish app/ui/dist
# and push the bot cloud function. A failed function push does not fail the static deploy.
# Does not install plugins on the kernel. Does not print tokens.
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

npm --prefix "$ROOT/app" ci
npm --prefix "$ROOT/app" run build
node "$ROOT/scripts/build-function.mjs"

python3 - "$DIST/index.html" <<'PY'
import sys
from pathlib import Path
html = Path(sys.argv[1]).read_text()
if "location.replace" in html or "camp.aigc.sx.cn" in html:
    raise SystemExit("refusing to deploy: dist/index.html points the browser at camp")
print("dist/index.html stays on the Demox origin")
PY

ID=""
if [[ -f "$META" ]]; then
  ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$META")"
  PROJECT_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("projectId") or "PQBDTM6GLZ")' "$META")"
fi

DEMOX=(npx --yes @demox-site/cli@1.1.6)
FN_DIR="$ROOT/functions/bot"
FN_SLUG="bot"
FN_ROUTES="/api/bot,/api/bot/feed"
alias_hint() {
  echo "别名：第一次 functions push 创建 v1，production 和 develop 都指向 v1。"
  echo "再上传只增加版本，不会移动别名。要让线上用新版本："
  echo "  ${DEMOX[*]} functions alias set --id ${ID:-IVBLF9PE} --slug ${FN_SLUG} production --version=N"
  echo "routes 只能在创建函数时设置，必须包含 ${FN_ROUTES}。"
}

if [[ -z "${DEMOX_TOKEN:-}" && ! -f "${HOME}/.demox/token.json" ]]; then
  echo "未登录 Demox（没有 DEMOX_TOKEN，也没有 ~/.demox/token.json）。已构建，但没有发布静态站点，也没有推送云函数。"
  echo "登录后重新执行 ./scripts/deploy-demox.sh"
  echo "或手动："
  echo "  npx --yes @demox-site/cli@1.1.6 deploy $DIST --name $NAME --project $PROJECT_ID --id ${ID:-IVBLF9PE}"
  echo "  npx --yes @demox-site/cli@1.1.6 functions push $FN_DIR --id ${ID:-IVBLF9PE} --slug $FN_SLUG --name bot --routes $FN_ROUTES"
  alias_hint
  exit 1
fi

DEPLOY_ARGS=(deploy "$DIST" --name "$NAME" --project "$PROJECT_ID")
if [[ -n "$ID" ]]; then
  echo "Updating Demox site $ID in project $PROJECT_ID"
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
merged = dict(existing)
merged.update({
    "id": site_id,
    "name": "$NAME",
    "url": url if url.endswith("/") else url + "/",
    "origin_host": origin_host,
    "projectId": "$PROJECT_ID",
    "projectSlug": existing.get("projectSlug") or "botcamp",
    "projectName": existing.get("projectName") or "botcamp",
})
meta_path.write_text(json.dumps(merged, indent=2) + "\n")
print(f"Wrote {meta_path}: {site_id} -> {url}")
PY

ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$META")"
echo "推送云函数 ${FN_SLUG}（routes 仅创建时生效）: ${FN_ROUTES}"
set +e
"${DEMOX[@]}" functions push "$FN_DIR" --id "$ID" --slug "$FN_SLUG" --name bot --routes "$FN_ROUTES" | tee "$tmpdir/fn.log"
push_status=${PIPESTATUS[0]}
set -e
if [[ "$push_status" -ne 0 ]]; then
  echo "静态站点已发布。云函数推送失败，请执行："
  echo "  ${DEMOX[*]} functions push \"$FN_DIR\" --id $ID --slug $FN_SLUG --name bot --routes $FN_ROUTES"
  alias_hint
else
  version="$(python3 - "$tmpdir/fn.log" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
uploaded = re.search(r"已上传 v(\d+)", text)
version_line = re.search(r"版本:\s*(\d+)", text)
match = uploaded or version_line
print(match.group(1) if match else "")
PY
)"
  if [[ -n "$version" ]]; then
    echo "把 production 别名指到 v${version}"
    "${DEMOX[@]}" functions alias set --id "$ID" --slug "$FN_SLUG" production --version="$version"
  else
    alias_hint
  fi
fi
