#!/bin/bash
# BotCamp relay: keep this Mac's bot team reachable through the server.
set -u
export DSH_HOME="$HOME/.botcamp"
set -a; . "$HOME/.botcamp/relay.env"; set +a

SSH_KEY=/Users/phosa/.agents/skills/server-mgmt/secrets/keys/id_ed25519_aigc
REMOTE=root@server.aigc.sx.cn
LOCAL_PORT=8765
BASE=https://camp.aigc.sx.cn/botcamp/api/relay

DEVICE_UUID=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')
DEVICE_ID=$(printf '%s' "${DEVICE_UUID:-$(hostname)}" | shasum -a 256 | cut -c1-16)
DEVICE_NAME=$(scutil --get ComputerName 2>/dev/null || hostname)
PLATFORM="macOS $(sw_vers -productVersion 2>/dev/null)"

start_host() {
  if lsof -nP -iTCP:$LOCAL_PORT -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
  nohup npx -y @deepseek-ai/dsh@0.2.1-rc.2 web \
    --host 127.0.0.1 --port $LOCAL_PORT --no-open \
    --public-url http://127.0.0.1:$LOCAL_PORT --trusted-host 127.0.0.1:$LOCAL_PORT \
    >> "$HOME/.botcamp/relay-web.log" 2>&1 &
  for i in $(seq 1 30); do
    lsof -nP -iTCP:$LOCAL_PORT -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

current_token() {
  grep -o "token=[A-Za-z0-9_-]*" "$HOME/.botcamp/relay-web.log" 2>/dev/null | tail -1 | cut -d= -f2
}

heartbeat() {
  local tok
  tok=$(current_token)
  curl -s -m 15 -X POST "$BASE/../devices/heartbeat" \
    -H "content-type: application/json" -H "authorization: Bearer $RELAY_DEVICE_SECRET" \
    -d "{\"token\":\"$tok\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('slot',''))"
}

start_host || { echo "host failed to start" >&2; exit 1; }

while true; do
  SLOT=$(heartbeat)
  if [ -z "$SLOT" ]; then
    echo "$(date -u +%FT%TZ) heartbeat failed, retrying in 10s" >> "$HOME/.botcamp/relay-tunnel.log"
    sleep 10; continue
  fi
  PORT=$((18764 + SLOT))
  ssh -N -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R 127.0.0.1:$PORT:127.0.0.1:$LOCAL_PORT "$REMOTE"
  echo "$(date -u +%FT%TZ) slot $SLOT tunnel dropped, retrying in 5s" >> "$HOME/.botcamp/relay-tunnel.log"
  sleep 5
done
