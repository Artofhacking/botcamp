#!/usr/bin/env bash
# 让 camp 的 GET / 只对网关换 dsh-auth。浏览器打开 / 仍然是纯文本 404。
# 需要环境变量 sshkey（私钥内容）以及已经登录的 Demox CLI。
# 不打印私钥、交换口令、管理员密码或 cookie。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_ID="${DEMOX_SITE_ID:-IVBLF9PE}"
HOST="${CAMP_SSH_HOST:-root@119.91.123.2}"
KEY_FILE="$(mktemp)"
REMOTE="$(mktemp)"
cleanup() { rm -f "$KEY_FILE" "$REMOTE"; }
trap cleanup EXIT
chmod 600 "$KEY_FILE"

if [[ -z "${sshkey:-}" ]]; then
  echo "没有环境变量 sshkey，无法登录 ${HOST}。"
  exit 1
fi
printf '%s\n' "$sshkey" > "$KEY_FILE"
if ! grep -q 'BEGIN ' "$KEY_FILE"; then
  echo "sshkey 不是私钥文本。"
  exit 1
fi

SECRET="$(
  npx --yes @demox-site/cli@1.1.6 env list --id "$SITE_ID" --slug bot \
    | python3 -c 'import sys
for line in sys.stdin:
    if line.startswith("BOTCAMP_KERNEL_EXCHANGE="):
        print(line.split("=", 1)[1].strip())
        break'
)"
if [[ -z "$SECRET" ]]; then
  echo "函数环境里还没有 BOTCAMP_KERNEL_EXCHANGE。先设置它，再运行这个脚本。"
  exit 1
fi

python3 - "$SECRET" "$ROOT/deploy/nginx/camp.conf" "$REMOTE" <<'PY'
import sys
from pathlib import Path
secret, conf, remote = sys.argv[1:]
snippet = (
    "set $botcamp_exchange 0;\n"
    f'if ($http_x_botcamp_exchange = "{secret}") {{\n'
    "    set $botcamp_exchange 1;\n"
    "}\n"
)
marker = "\n-----BOTCAMP-CONF-----\n"
Path(remote).write_text(snippet + marker + Path(conf).read_text())
PY

scp -i "$KEY_FILE" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  "$REMOTE" "${HOST}:/tmp/botcamp-exchange.payload"
ssh -i "$KEY_FILE" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$HOST" bash -s <<'EOS'
set -euo pipefail
if [[ ! -f /etc/nginx/snippets/dsh-camp-token.conf ]]; then
  echo "服务器上没有 /etc/nginx/snippets/dsh-camp-token.conf，不能换票。"
  exit 1
fi
python3 - <<'PY'
from pathlib import Path
payload = Path("/tmp/botcamp-exchange.payload").read_text()
snippet, conf = payload.split("\n-----BOTCAMP-CONF-----\n", 1)
Path("/etc/nginx/snippets/dsh-camp-exchange.conf").write_text(snippet)
live = Path("/etc/nginx/sites-available/camp.conf")
if not live.exists():
    candidates = list(Path("/etc/nginx/sites-enabled").glob("*")) + list(Path("/etc/nginx/conf.d").glob("*camp*"))
    text = ""
    for path in candidates:
        try:
            text = path.read_text()
        except OSError:
            continue
        if "camp.aigc.sx.cn" in text:
            live = path
            break
    else:
        raise SystemExit("找不到正在使用的 camp.aigc.sx.cn 配置")
backup = Path(str(live) + ".botcamp-bak")
backup.write_text(live.read_text())
live.write_text(conf)
print(f"updated {live}")
PY
rm -f /tmp/botcamp-exchange.payload
if ! nginx -t; then
  python3 - <<'PY'
from pathlib import Path
for path in list(Path("/etc/nginx/sites-enabled").glob("*")) + list(Path("/etc/nginx/sites-available").glob("*")) + list(Path("/etc/nginx/conf.d").glob("*")):
    backup = Path(str(path) + ".botcamp-bak")
    if backup.exists():
        path.write_text(backup.read_text())
        print(f"restored {path}")
PY
  exit 1
fi
systemctl reload nginx
EOS
rm -f "$REMOTE"
echo "camp 的换票路径已装上。浏览器打开 / 仍应是纯文本 404。"
