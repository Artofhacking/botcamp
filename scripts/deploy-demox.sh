#!/usr/bin/env bash
# Deploy ./dist to Demox. Reuses site id from demox-site.json when present.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
META="$ROOT/demox-site.json"
NAME="${DEMOX_SITE_NAME:-botcamp-dsh-frontend}"

if [[ ! -d "$DIST" ]]; then
  echo "missing $DIST — run scripts/sync-frontend-from-server.sh first" >&2
  exit 1
fi

# Optional: materialize DEMOX_TOKEN into ~/.demox/token.json
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

DEMOX=(npx --yes @demox-site/cli)
ID=""
if [[ -f "$META" ]]; then
  ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$META")"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
LOG="$tmpdir/deploy.log"

if [[ -n "$ID" ]]; then
  echo "Updating Demox site $ID ..."
  "${DEMOX[@]}" deploy "$DIST" --name "$NAME" --id "$ID" | tee "$LOG"
else
  echo "Creating new Demox site ..."
  "${DEMOX[@]}" deploy "$DIST" --name "$NAME" | tee "$LOG"
fi

python3 - <<PY
import json, re
from pathlib import Path
text = Path("$LOG").read_text()
meta_path = Path("$META")
existing = json.loads(meta_path.read_text()) if meta_path.exists() else {}
m_id = re.search(r"\bID:\s*([A-Z0-9]+)", text)
m_url = re.search(r"https://[a-z0-9]+\.demox\.site/", text)
site_id = (m_id.group(1) if m_id else existing.get("id") or "$ID").strip()
url = (m_url.group(0) if m_url else existing.get("url") or "").strip()
if not site_id or not url:
    raise SystemExit("could not parse Demox deploy output")
origin_host = url.rstrip("/").split("//", 1)[-1]
meta_path.write_text(json.dumps({
    "id": site_id,
    "name": "$NAME",
    "url": url,
    "origin_host": origin_host,
}, indent=2) + "\n")
print(f"Wrote {meta_path}: {site_id} -> {url}")
PY
