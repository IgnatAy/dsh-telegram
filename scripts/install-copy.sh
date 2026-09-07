#!/bin/bash
# Local plug-and-play installer for the telegram plugin — no pnpm, no npm,
# no registry. Copies the built plugin folder into a dsh profile and
# registers the `telegram` row in that profile's patch layer.
#
# Why this works without installing anything: the plugin is copied UNDER the
# profile directory, so at runtime Node's parent-directory walk from the
# plugin resolves its @deepseek-ai/* peers from the profile's flat module
# fallback ($DSH_HOME/profiles/node_modules, maintained by dsh at every
# boot). No per-plugin node_modules is needed.
#
# Usage:
#   bash scripts/install-copy.sh [profile]      # install into a profile (default: web)
#   bash scripts/install-copy.sh uninstall      # remove from the web profile
#   bash scripts/install-copy.sh uninstall <p>  # remove from a named profile
#
# After installing, set the environment and restart the profile:
#   DSH_TELEGRAM_TOKEN=<token> DSH_TELEGRAM_ALLOWED_USER_IDS=<ids> dsh --profile web
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
case "$DSH_HOME" in
  '~') DSH_HOME="$HOME" ;;
  '~/'*) DSH_HOME="$HOME/${DSH_HOME#\~/}" ;;
  /*) ;;
  *) DSH_HOME="$(pwd)/$DSH_HOME" ;;
esac
MARKER_BEGIN='# telegram plugin begin (managed by scripts/install-copy.sh)'
MARKER_END='# telegram plugin end (managed by scripts/install-copy.sh)'
LEGACY_MARKER='# telegram plugin (local copy; managed by scripts/install-copy.sh)'

strip_managed_patch() {
  local input="$1"
  local output="$2"
  awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" -v legacy="$LEGACY_MARKER" '
    $0 == begin { managed = 1; next }
    managed && $0 == end { managed = 0; next }
    managed { next }
    $0 == legacy { legacy_rows = 3; next }
    legacy_rows > 0 { legacy_rows -= 1; next }
    { print }
  ' "$input" > "$output"
}

validate_profile() {
  local profile="$1"
  if ! printf '%s' "$profile" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]*$' \
    || [ "$profile" = "." ] || [ "$profile" = ".." ]; then
    echo "install: invalid profile name '$profile'" >&2
    exit 1
  fi
}

init_telegram_profile() {
  local profile_dir="$1"
  mkdir -p "$profile_dir"
  printf '%s\n' \
    '{' \
    '  "name": "dsh-profile-telegram",' \
    '  "private": true,' \
    '  "dsh": {' \
    '    "profile": {' \
    '      "bundles": ["@deepseek-ai/dsh-base"],' \
    '      "patchReload": "startup"' \
    '    }' \
    '  }' \
    '}' > "$profile_dir/package.json"
  printf '[]\n' > "$profile_dir/cordis.patch.yml"
  echo "created dedicated telegram profile at $profile_dir"
}

ARG="${1:-}"
if [ "$ARG" = "uninstall" ]; then
  PROFILE="${2:-web}"
  validate_profile "$PROFILE"
  TARGET="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-telegram"
  PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
  if [ -d "$TARGET" ]; then
    chmod -R u+w "$TARGET"
    rm -rf "$TARGET"
    echo "removed $TARGET"
  else
    echo "note: $TARGET does not exist"
  fi
  if [ -f "$PATCH" ] \
    && { grep -qF "$MARKER_BEGIN" "$PATCH" || grep -qF "$LEGACY_MARKER" "$PATCH"; }; then
    TEMP_PATCH="$(mktemp "${PATCH}.telegram.XXXXXX")"
    strip_managed_patch "$PATCH" "$TEMP_PATCH"
    mv "$TEMP_PATCH" "$PATCH"
    if ! grep -qE '^[[:space:]]*[^#[:space:]]' "$PATCH"; then
      printf '\n[]\n' >> "$PATCH"
    fi
    echo "removed the telegram row from $PATCH"
  else
    echo "note: no telegram block found in $PATCH (remove the row manually if needed)"
  fi
  echo "next: restart the profile (dsh --profile $PROFILE)"
  exit 0
fi

PROFILE="${ARG:-web}"
validate_profile "$PROFILE"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
TARGET="$PROFILE_DIR/node_modules/dsh-telegram"
PATCH="$PROFILE_DIR/cordis.patch.yml"

# --- Preconditions ----------------------------------------------------------
if [ ! -f "$ROOT/lib/index.js" ]; then
  echo "install: lib/index.js missing — run \`bash scripts/build.sh\` first" >&2
  exit 1
fi
if [ ! -f "$ROOT/package.json" ]; then
  echo "install: cannot find package.json at $ROOT" >&2
  exit 1
fi
if [ ! -d "$PROFILE_DIR" ]; then
  if [ "$PROFILE" = "telegram" ]; then
    init_telegram_profile "$PROFILE_DIR"
  else
    echo "install: profile '$PROFILE' not found at $PROFILE_DIR" >&2
    exit 1
  fi
fi
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "install: profile manifest missing at $PROFILE_DIR/package.json" >&2
  exit 1
fi
if [ ! -f "$PATCH" ]; then
  echo "install: profile patch missing at $PATCH" >&2
  exit 1
fi

# --- Stage then replace the built plugin (lib/ + manifest + bundle patch) --
TARGET_PARENT="$PROFILE_DIR/node_modules"
mkdir -p "$TARGET_PARENT"
STAGE="$(mktemp -d "$TARGET_PARENT/.telegram.install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -r "$ROOT/lib" "$STAGE/lib"
cp "$ROOT/package.json" "$STAGE/package.json"
cp "$ROOT/cordis.patch.yml" "$STAGE/cordis.patch.yml"
# Windows ADS artifacts that may sit next to repo files are not needed.
chmod -R u+rwX "$STAGE"
find "$STAGE" -name '*Zone.Identifier' -delete 2>/dev/null || true
if [ -d "$TARGET" ]; then
  chmod -R u+w "$TARGET"
fi
rm -rf "$TARGET"
mv "$STAGE" "$TARGET"
trap - EXIT
echo "installed $TARGET"

# --- Register managed composition rows (idempotent, including upgrades) ----
TEMP_PATCH="$(mktemp "${PATCH}.telegram.XXXXXX")"
strip_managed_patch "$PATCH" "$TEMP_PATCH"
NEED_TELEGRAM=true
NEED_WORKSPACE=false
NEED_SESSION_CONTROLLER=false
if grep -qE '^[[:space:]]*- id: telegram([[:space:]]|$)' "$TEMP_PATCH"; then
  NEED_TELEGRAM=false
fi
# A dedicated base-only profile does not otherwise provide workspaceRegistry.
if [ "$PROFILE" = "telegram" ] \
  && ! grep -qE '^[[:space:]]*- id: workspace([[:space:]]|$)' "$TEMP_PATCH"; then
  NEED_WORKSPACE=true
fi
if [ "$PROFILE" = "telegram" ] \
  && ! grep -qE '^[[:space:]]*- id: session-controller([[:space:]]|$)' "$TEMP_PATCH"; then
  NEED_SESSION_CONTROLLER=true
fi
if [ "$NEED_TELEGRAM" = true ] || [ "$NEED_WORKSPACE" = true ] \
  || [ "$NEED_SESSION_CONTROLLER" = true ]; then
  CLEAN_PATCH="$(mktemp "${PATCH}.telegram.clean.XXXXXX")"
  awk '!/^[[:space:]]*\[\][[:space:]]*$/' "$TEMP_PATCH" > "$CLEAN_PATCH"
  mv "$CLEAN_PATCH" "$TEMP_PATCH"
  if [ -s "$TEMP_PATCH" ] && grep -q '[^[:space:]]' "$TEMP_PATCH"; then
    printf '\n' >> "$TEMP_PATCH"
  fi
  printf '%s\n- insert:\n' "$MARKER_BEGIN" >> "$TEMP_PATCH"
  if [ "$NEED_WORKSPACE" = true ]; then
    printf '    - id: workspace\n      name: '\''@deepseek-ai/dsh-workspace'\''\n' >> "$TEMP_PATCH"
  fi
  if [ "$NEED_SESSION_CONTROLLER" = true ]; then
    printf '    - id: session-controller\n      name: '\''@deepseek-ai/dsh-api-session-controller'\''\n' >> "$TEMP_PATCH"
  fi
  if [ "$NEED_TELEGRAM" = true ]; then
    printf '    - id: telegram\n      name: '\''dsh-telegram'\''\n' >> "$TEMP_PATCH"
  fi
  printf '%s\n' "$MARKER_END" >> "$TEMP_PATCH"
fi
if ! grep -qE '^[[:space:]]*[^#[:space:]]' "$TEMP_PATCH"; then
  printf '\n[]\n' >> "$TEMP_PATCH"
fi
mv "$TEMP_PATCH" "$PATCH"
echo "registered the Telegram composition in $PATCH"

if [ "$PROFILE" = "telegram" ]; then
  cat <<EOF

next steps:
  1. set DSH_TELEGRAM_TOKEN and DSH_TELEGRAM_ALLOWED_USER_IDS
  2. start through ./run-wsl.sh; this profile uses the shared durable DSH history
  3. uninstall later with:  bash scripts/install-copy.sh uninstall telegram
EOF
else
  cat <<EOF

next steps:
  1. restart the profile so the new composition loads:
       dsh --profile $PROFILE
  2. set DSH_TELEGRAM_TOKEN and DSH_TELEGRAM_ALLOWED_USER_IDS first
  3. uninstall later with:  bash scripts/install-copy.sh uninstall $PROFILE
EOF
fi
