#!/usr/bin/env bash
# Reset one BotCamp account to a clean first-run test state.
# Keeps profiles/plugins, model credentials, login state, and all backups.
set -euo pipefail

ACCOUNT="${BOTCAMP_ACCOUNT:-$HOME/.botcamp/accounts/648986b0ec90}"
LAUNCH="${LAUNCH:-1}"

case "$ACCOUNT" in
  "$HOME"/.botcamp/accounts/*) ;;
  *) echo "refusing: account must be under $HOME/.botcamp/accounts" >&2; exit 2 ;;
esac
[ -d "$ACCOUNT/profiles" ] || { echo "refusing: not a BotCamp account: $ACCOUNT" >&2; exit 2; }

BK="$HOME/.botcamp/backups/account-$(basename "$ACCOUNT")-before-test-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"

# Stop the app and its host before touching state.
pkill -TERM -f '/Applications/BotCamp.app/Contents/MacOS/BotCamp' 2>/dev/null || true
sleep 3
pkill -9 -f '/Applications/BotCamp.app/Contents/MacOS/BotCamp' 2>/dev/null || true

for item in bot sessions storages attachments logs recovery deleted-bots; do
  if [ -e "$ACCOUNT/$item" ]; then
    ditto "$ACCOUNT/$item" "$BK/$item"
    rm -rf -- "$ACCOUNT/$item"
  fi
done
mkdir -p "$ACCOUNT/sessions"

# Name->ID lookup cache is test data too; profile/plugin/config stay.
rm -f -- "$HOME/.botcamp/library-research-names.json"

echo "backup: $BK"
echo "cleared: bot state, sessions, workspace/docs, onboarding, attachments, logs, recovery, deleted bots, research name cache"
echo "kept: profiles/plugins, credentials, login, app patches, backups"

if [ "$LAUNCH" = "1" ]; then
  KEY="$(awk '/^  BOTCAMP_LLM_KEY:/{print $2}' "$HOME/.botcamp/.credentials.yaml")"
  env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="zh_CN.UTF-8" TMPDIR="$(getconf DARWIN_USER_TEMP_DIR)" BOTCAMP_LLM_KEY="$KEY" \
    "/Applications/BotCamp.app/Contents/MacOS/BotCamp" >/tmp/botcamp-test-reset.log 2>&1 &
  sleep 8
  echo "app: launched; onboarding and 主编 + 5 specialists should be recreated"
fi
