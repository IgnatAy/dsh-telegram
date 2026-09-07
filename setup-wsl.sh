#!/usr/bin/env bash
# One-time, user-local WSL setup. Uses the committed build by default and
# copies the plugin into the Web profile so Bot and Web share one DSH process.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REBUILD="${1:-}"
PROFILE="${DSH_TELEGRAM_PROFILE:-web}"
if [ -n "$REBUILD" ] && [ "$REBUILD" != "--rebuild" ]; then
  echo "usage: $0 [--rebuild]" >&2
  exit 2
fi

for command in node dsh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "setup: required command not found: $command" >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if ! { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 19 ]; } \
  && [ "$NODE_MAJOR" -lt 24 ]; then
  echo "setup: Node.js 22.19+ or 24+ is required (current: $(node --version))" >&2
  exit 1
fi

if [ "$REBUILD" = "--rebuild" ] || [ ! -f "$ROOT/lib/index.js" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "setup: pnpm is required to rebuild lib/" >&2
    exit 1
  fi
  (cd "$ROOT" && pnpm install --frozen-lockfile && pnpm run build)
fi

bash "$ROOT/scripts/install-copy.sh" "$PROFILE"

cat <<'EOF'

setup complete. Start the bot with:
  export DSH_TELEGRAM_TOKEN='<BotFather token>'
  export DSH_TELEGRAM_ALLOWED_USER_IDS='<comma-separated Telegram user ids>'
  ./run-wsl.sh
EOF
