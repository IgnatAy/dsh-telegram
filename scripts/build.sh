#!/bin/bash
# Build the telegram external plugin: compile src/ → lib/ (JS) and
# lib/types/ (declarations) against the INSTALLED dsh packages.
#
# This environment has no dsh source checkout: dsh ships as an npx-installed
# app (`@deepseek-ai/dsh` plus its whole `@deepseek-ai/*` dependency closure
# hoisted in one node_modules). The script resolves that install root and
# symlinks the packages the plugin imports from it, so tsc type-checks
# against the exact packages the running dsh loads — and the very same links
# double as the runtime peer-resolution bridge for the installed plugin
# (Node resolves a symlinked plugin by its realpath, so the plugin must find
# its peers from its own node_modules, not the profile's).
#
# When `dsh` is on PATH (or `DSH_ROOT` names its install root), the build uses
# that runtime's peer packages. Otherwise a normal local `pnpm install`
# supplies the declared peers and development dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Locate the dsh install root (the dir whose node_modules has @deepseek-ai) ---
resolve_dsh_root() {
  if [ -n "${DSH_ROOT:-}" ]; then
    echo "$DSH_ROOT"
    return 0
  fi
  if command -v dsh &>/dev/null; then
    local launcher
    launcher=$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)
    # The launcher (possibly a symlink into a package) lives inside the install
    # root; walk up until we find the dir whose node_modules has @deepseek-ai.
    local dir
    dir=$(dirname "$launcher")
    local i=0
    while [ "$i" -lt 16 ]; do
      if [ -d "$dir/node_modules/@deepseek-ai" ]; then
        echo "$dir"
        return 0
      fi
      [ "$dir" = "/" ] && break
      dir=$(dirname "$dir")
      i=$((i + 1))
    done
  fi
  return 1
}

DSH_ROOT="$(resolve_dsh_root || true)"

# --- Local TypeScript (devDependency) ---
TSC="$ROOT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  echo "build: tsc not found at $TSC — run \`pnpm install\` in $ROOT first" >&2
  exit 1
fi

# Link one build-time dependency from the install root: <name>.
# Missing optional targets warn and continue; required ones fail.
link_pkg() {
  local target="$DSH_ROOT/node_modules/$1"
  if [ ! -e "$target" ]; then
    if [ "${2:-}" = "required" ]; then
      echo "build: required dependency missing: $target" >&2
      exit 1
    fi
    echo "build: note: $1 not found in the install root; skipping" >&2
    return 0
  fi
  mkdir -p "$(dirname "node_modules/$1")"
  ln -sfn "$target" "node_modules/$1"
}

if [ -n "$DSH_ROOT" ] && [ -d "$DSH_ROOT/node_modules/@deepseek-ai" ]; then
  echo "=== Linking runtime peer dependencies (root: $DSH_ROOT) ==="
  mkdir -p node_modules/@deepseek-ai
  link_pkg @deepseek-ai/cordis required
  link_pkg @deepseek-ai/schemastery required
  link_pkg @deepseek-ai/dsh-agent required
  link_pkg @deepseek-ai/dsh-agent-presets required
  link_pkg @deepseek-ai/dsh-attachment required
  link_pkg @deepseek-ai/dsh-llm required
  link_pkg @deepseek-ai/dsh-session required
  link_pkg @deepseek-ai/dsh-session-persistence required
  link_pkg @deepseek-ai/dsh-session-query required
  link_pkg @deepseek-ai/dsh-system-prompt required
  link_pkg @deepseek-ai/dsh-workspace required
else
  echo "=== dsh install root not found; using locally installed peer dependencies ==="
fi

for package in \
  @deepseek-ai/cordis \
  @deepseek-ai/schemastery \
  @deepseek-ai/dsh-agent \
  @deepseek-ai/dsh-agent-presets \
  @deepseek-ai/dsh-attachment \
  @deepseek-ai/dsh-llm \
  @deepseek-ai/dsh-session \
  @deepseek-ai/dsh-session-persistence \
  @deepseek-ai/dsh-session-query \
  @deepseek-ai/dsh-system-prompt \
  @deepseek-ai/dsh-workspace
do
  if [ ! -f "node_modules/$package/package.json" ]; then
    echo "build: required dependency missing: node_modules/$package (run \`pnpm install\`)" >&2
    exit 1
  fi
done

echo "=== Compiling src → lib (tsc $("$TSC" --version)) ==="
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
ls -la lib/ lib/types/
