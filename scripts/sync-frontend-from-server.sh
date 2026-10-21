#!/usr/bin/env bash
# Pull @deepseek-ai/dsh-web-frontend/dist from the Tencent Cloud dsh host into ./dist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DSH_SSH_HOST:?set DSH_SSH_HOST}"
USER="${DSH_SSH_USER:-root}"
PORT="${DSH_SSH_PORT:-22}"
KEY_FILE="${DSH_SSH_KEY_FILE:-$HOME/.ssh/dsh_key}"

DIST_REMOTE="${DSH_FRONTEND_DIST_REMOTE:-/usr/local/n/versions/node/24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist}"

SSH=(ssh -o IdentitiesOnly=yes -o BatchMode=yes -p "$PORT")
if [[ -f "$KEY_FILE" ]]; then
  SSH+=(-i "$KEY_FILE")
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Pulling $DIST_REMOTE from ${USER}@${HOST} ..."
"${SSH[@]}" "${USER}@${HOST}" "tar -C '$DIST_REMOTE' -czf - ." | tar -C "$tmpdir" -xzf -

rm -rf "$ROOT/dist"
mkdir -p "$ROOT/dist"
cp -a "$tmpdir"/. "$ROOT/dist/"
echo "Synced into $ROOT/dist ($(du -sh "$ROOT/dist" | awk '{print $1}'))"
