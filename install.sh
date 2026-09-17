#!/usr/bin/env bash
# Local entry point, also usable via curl | bash -s -- install/uninstall.
set -euo pipefail
ACTION="${1:-install}"
PROFILE="${2:-${DSH_TELEGRAM_PROFILE:-web}}"
if [ "$#" -gt 2 ] || { [ "$ACTION" != install ] && [ "$ACTION" != uninstall ]; }; then
  echo 'usage: bash install.sh [install|uninstall] [profile]' >&2
  exit 2
fi
if [[ ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || [ "$PROFILE" = node_modules ]; then
  echo 'install: invalid profile name' >&2
  exit 2
fi

# Piped invocations download one complete snapshot, including committed lib/.
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  ROOT=''
fi
if [ -z "$ROOT" ] || [ ! -f "$ROOT/scripts/install-copy.sh" ]; then
  TEMP_ROOT="$(mktemp -d)"
  trap 'rm -rf "$TEMP_ROOT"' EXIT
  curl -fsSL https://codeload.github.com/IgnatAy/dsh-telegram/tar.gz/refs/heads/main -o "$TEMP_ROOT/source.tar.gz"
  mkdir "$TEMP_ROOT/source"
  tar -xzf "$TEMP_ROOT/source.tar.gz" -C "$TEMP_ROOT/source" --strip-components=1
  ROOT="$TEMP_ROOT/source"
fi
if [ "$ACTION" = uninstall ]; then
  bash "$ROOT/scripts/install-copy.sh" uninstall "$PROFILE"
else
  if ! command -v node >/dev/null 2>&1; then
    echo 'install: Node.js 22.19+ or 24+ is required' >&2
    exit 1
  fi
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!(major === 22 && minor >= 19 || major >= 24)) { console.error("install: Node.js 22.19+ or 24+ is required"); process.exit(1) }'
  bash "$ROOT/scripts/install-copy.sh" "$PROFILE"
fi
