#!/usr/bin/env bash
# Run Telegram inside the Web profile against the durable DSH workspace and
# session stores. The bot starts unbound; users list and select through /use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${DSH_TELEGRAM_PROFILE:-web}"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"

case "$DSH_ROOT" in
  '~') DSH_ROOT="$HOME" ;;
  '~/'*) DSH_ROOT="$HOME/${DSH_ROOT#\~/}" ;;
  /*) ;;
  *) DSH_ROOT="$(pwd)/$DSH_ROOT" ;;
esac
if [ "$#" -gt 0 ]; then
  echo "usage: $0" >&2
  exit 2
fi
if ! command -v dsh >/dev/null 2>&1; then
  echo "run: dsh is not on PATH" >&2
  exit 1
fi
if [ -z "${DSH_TELEGRAM_TOKEN:-}" ]; then
  echo "run: DSH_TELEGRAM_TOKEN is required" >&2
  exit 1
fi
if [ -z "${DSH_TELEGRAM_ALLOWED_USER_IDS:-}" ] \
  && [ "${DSH_TELEGRAM_ALLOW_ALL_USERS:-false}" != "true" ]; then
  echo "run: set DSH_TELEGRAM_ALLOWED_USER_IDS, or explicitly set DSH_TELEGRAM_ALLOW_ALL_USERS=true" >&2
  exit 1
fi
if [ ! -f "$DSH_ROOT/profiles/$PROFILE/node_modules/dsh-telegram/lib/index.js" ]; then
  echo "run: plugin is not installed in profile '$PROFILE'; run ./setup-wsl.sh first" >&2
  exit 1
fi

export DSH_TELEMETRY_DISABLED=1

echo "telegram startup selection: none (use /use in Telegram)"
echo "telegram workspace/session state: $DSH_ROOT"
echo "telegram profile: $PROFILE"

cd "$ROOT"
dsh --profile "$PROFILE" --patch "$ROOT/wsl.shared.patch.yml"
