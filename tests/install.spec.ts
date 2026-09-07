import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../scripts/install-copy.sh', import.meta.url))
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'telegram-install-'))
  homes.push(home)
  const env = { ...process.env, DSH_HOME: home }
  const run = (...args: string[]) => execFileSync('bash', [installer, ...args], { env, encoding: 'utf8' })
  return { home, env, run }
}

describe('profile copy installer', () => {
  it('upgrades a dedicated profile without duplicating rows or replacing user config', () => {
    const { home, run } = fixture()
    run('telegram')
    const profile = join(home, 'profiles/telegram')
    const patch = join(profile, 'cordis.patch.yml')
    const custom = '\n- id: tools\n  config:\n    mode: native\n'
    writeFileSync(patch, readFileSync(patch, 'utf8') + custom)
    writeFileSync(join(profile, 'node_modules/dsh-telegram/lib/index.js'), 'old alpha build')
    run('telegram')
    const updated = readFileSync(patch, 'utf8')
    expect(updated).toContain(custom.trim())
    for (const id of ['workspace', 'session-controller', 'agent-presets', 'subagent-model-selection-settings', 'telegram']) {
      expect(updated.match(new RegExp('    - id: ' + id + '\\n', 'g'))).toHaveLength(1)
    }
    expect(readFileSync(join(profile, 'node_modules/dsh-telegram/lib/index.js'), 'utf8')).not.toContain('old alpha build')
    expect(JSON.parse(readFileSync(join(profile, 'node_modules/dsh-telegram/package.json'), 'utf8')).version).toBe('0.2.1')
  })

  it('replaces legacy installer rows and leaves unrelated web settings on uninstall', () => {
    const { home, run } = fixture()
    const profile = join(home, 'profiles/web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), '{"private":true}')
    const patch = join(profile, 'cordis.patch.yml')
    const custom = '- id: tools\n  config:\n    mode: native\n'
    writeFileSync(patch, custom + '# telegram plugin (local copy; managed by scripts/install-copy.sh)\n- insert:\n    - id: telegram\n      name: dsh-telegram\n')
    run('web')
    run('web')
    expect(readFileSync(patch, 'utf8').match(/    - id: telegram\n/g)).toHaveLength(1)
    run('uninstall', 'web')
    expect(readFileSync(patch, 'utf8').trim()).toBe(custom.trim())
  })

  it('rejects the rc.1 reserved fallback directory for install and uninstall', () => {
    const { home, env } = fixture()
    const fallback = join(home, 'profiles/node_modules/node_modules/dsh-telegram')
    mkdirSync(fallback, { recursive: true })
    const marker = join(fallback, 'keep.txt')
    writeFileSync(marker, 'keep')
    for (const args of [['node_modules'], ['uninstall', 'node_modules']]) {
      const result = spawnSync('bash', [installer, ...args], { env, encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('invalid profile name')
      expect(readFileSync(marker, 'utf8')).toBe('keep')
    }
  })
})
