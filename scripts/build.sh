#!/bin/bash
# Compile source and declarations against DSH v0.1.2-rc.1.
# Uses the local frozen-lockfile dependencies by default. An explicit
# DSH_ROOT can point to a matching installed runtime; its versions are checked
# before links change so an old alpha installation cannot enter a release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DSH_ROOT="${DSH_ROOT:-}"
if [ -n "$DSH_ROOT" ]; then
  DSH_ROOT="$(cd "$DSH_ROOT" && pwd)"
fi

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
  node --input-type=module - "$DSH_ROOT" <<'NODE_CHECK'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const expected = JSON.parse(readFileSync('package.json', 'utf8')).devDependencies
for (const [name, version] of Object.entries(expected)) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue
  const file = join(root, 'node_modules', name, 'package.json')
  const actual = JSON.parse(readFileSync(file, 'utf8')).version
  if (actual !== version) {
    throw new Error('build: ' + name + ' requires the tested ' + version + ' build dependencies; found ' + actual + '. Update DSH or build with the local locked dependencies.')
  }
}
NODE_CHECK
  echo "=== Linking runtime peer dependencies (root: $DSH_ROOT) ==="
  mkdir -p node_modules/@deepseek-ai
  link_pkg @deepseek-ai/cordis required
  link_pkg @deepseek-ai/schemastery required
  link_pkg @deepseek-ai/dsh-agent required
  link_pkg @deepseek-ai/dsh-agent-presets required
  link_pkg @deepseek-ai/dsh-api-session-controller required
  link_pkg @deepseek-ai/dsh-attachment required
  link_pkg @deepseek-ai/dsh-llm required
  link_pkg @deepseek-ai/dsh-session required
  link_pkg @deepseek-ai/dsh-session-persistence required
  link_pkg @deepseek-ai/dsh-session-query required
  link_pkg @deepseek-ai/dsh-system-prompt required
  link_pkg @deepseek-ai/dsh-workspace required
else
  echo "=== Using locally locked rc.1 peer dependencies ==="
fi

for package in \
  @deepseek-ai/cordis \
  @deepseek-ai/schemastery \
  @deepseek-ai/dsh-agent \
  @deepseek-ai/dsh-agent-presets \
  @deepseek-ai/dsh-api-session-controller \
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
