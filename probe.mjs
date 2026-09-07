/**
 * telegram probe: verify the plugin against the CURRENT dsh deployment.
 *
 * Two checks:
 *   1. The built artifact loads against the installed dsh packages and keeps
 *      the namespace-plugin export shape (`name`, `inject`, `Config`,
 *      `apply`) — this fails fast if `scripts/build.sh` has not run or the
 *      runtime peer-resolution links are missing.
 *   2. When `dsh` is on PATH, the selected profile contains the plugin row
 *      created by `setup-wsl.sh` (the default is `web`).
 *
 * Usage:  node probe.mjs            (run from this repository root)
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

let failed = false

// --- Check 1: the built package loads and keeps its export shape -----------
if (!existsSync(new URL('lib/index.js', import.meta.url))) {
  console.error('probe: lib/index.js missing — run `bash scripts/build.sh` first')
  process.exit(1)
}
try {
  const telegram = await import('./lib/index.js')
  if (telegram.name !== 'telegram') throw new Error(`unexpected name ${JSON.stringify(telegram.name)}`)
  if (!Array.isArray(telegram.inject)
    || !telegram.inject.includes('agents')
    || !telegram.inject.includes('agentPresets')
    || !telegram.inject.includes('llm')
    || !telegram.inject.includes('sessionController')
    || !telegram.inject.includes('sessionPersistence')
    || !telegram.inject.includes('sessionQuery')
    || !telegram.inject.includes('workspaceRegistry')) {
    throw new Error(`unexpected inject ${JSON.stringify(telegram.inject)}`)
  }
  if (telegram.Config === undefined) throw new Error('Config export missing')
  if (typeof telegram.apply !== 'function') throw new Error('apply export missing')
  console.log(`probe: built plugin loads; export shape OK (inject=${JSON.stringify(telegram.inject)})`)
} catch (error) {
  console.error('probe: built plugin failed to load:', error instanceof Error ? error.message : error)
  process.exit(1)
}

// --- Check 2: the composed profile contains the telegram row ---------------
try {
  execFileSync('dsh', ['--version'], { stdio: 'ignore' })
} catch {
  console.log('probe: dsh not on PATH — skipping profile composition check')
  process.exit(failed ? 1 : 0)
}

try {
  const profile = process.env.DSH_TELEGRAM_PROFILE || 'web'
  const dump = execFileSync('dsh', ['--profile', profile, '--dump-config'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (dump.includes('telegram')) {
    console.log(`probe: profile ${profile} composition contains the telegram row`)
  } else {
    console.error(`probe: profile ${profile} composition does NOT contain a telegram row — run \`./setup-wsl.sh\` first`)
    failed = true
  }
} catch (error) {
  console.error('probe: dsh --profile --dump-config failed:', error instanceof Error ? error.message : String(error))
  failed = true
}

process.exit(failed ? 1 : 0)
