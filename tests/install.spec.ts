import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(JSON.parse(readFileSync(join(profile, 'node_modules/dsh-telegram/package.json'), 'utf8')).version).toBe('0.2.2')
    // Match DSH's shared profile fallback and import the copied build, including
    // its new persistence helper and rc2 title dependency.
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(home, 'profiles/node_modules'), 'dir')
    expect(execFileSync(process.execPath, ['--input-type=module', '-e',
      'const plugin = await import(process.argv[1]); console.log(typeof plugin.apply)',
      join(profile, 'node_modules/dsh-telegram/lib/index.js'),
    ], { encoding: 'utf8' }).trim()).toBe('function')
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

  it('rejects the reserved fallback directory for install and uninstall', () => {
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


describe('one-command entry point', () => {
  const entry = fileURLToPath(new URL('../install.sh', import.meta.url))

  it('creates a stock web profile, upgrades idempotently, and preserves settings on uninstall without dsh', () => {
    const { home, env } = fixture()
    // A dsh executable that fails makes accidental global CLI use visible.
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'dsh'), '#!/bin/sh\nexit 97\n')
    chmodSync(join(bin, 'dsh'), 0o755)
    const run = (...args: string[]) => execFileSync('bash', [entry, ...args], {
      env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', cwd: home,
    })
    run()
    const profile = join(home, 'profiles/web')
    const manifest = join(profile, 'package.json')
    expect(JSON.parse(readFileSync(manifest, 'utf8')).dsh.profile).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live',
    })
    const originalManifest = readFileSync(manifest, 'utf8')
    const patch = join(profile, 'cordis.patch.yml')
    const custom = '\n- id: tools\n  config:\n    mode: native\n'
    writeFileSync(patch, readFileSync(patch, 'utf8') + custom)
    const history = join(home, 'history.jsonl')
    writeFileSync(history, 'keep history')
    run('install')
    expect(readFileSync(patch, 'utf8').match(/    - id: telegram\n/g)).toHaveLength(1)
    run('uninstall')
    run('uninstall')
    expect(existsSync(join(profile, 'node_modules/dsh-telegram'))).toBe(false)
    expect(readFileSync(patch, 'utf8').trim()).toBe(custom.trim())
    expect(readFileSync(manifest, 'utf8')).toBe(originalManifest)
    expect(readFileSync(history, 'utf8')).toBe('keep history')
  })

  it('launches npx from the caller directory without a repository patch', () => {
    const { home, env, run } = fixture()
    run('web')
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\npwd\nprintf "%s\\n" "$@"\n')
    chmodSync(join(bin, 'npx'), 0o755)
    const output = execFileSync('bash', [fileURLToPath(new URL('../run-wsl.sh', import.meta.url))], {
      cwd: home, encoding: 'utf8', env: {
        ...env, PATH: `${bin}:${process.env.PATH}`, DSH_TELEGRAM_TOKEN: 'test',
        DSH_TELEGRAM_ALLOWED_USER_IDS: '123',
      },
    })
    expect(output).toContain(home + '\n@deepseek-ai/dsh\n--profile\nweb\n')
    expect(output).not.toContain('--patch')
  })

  it('installs and uninstalls through stdin using a downloaded snapshot', () => {
    const { home, env } = fixture()
    const root = fileURLToPath(new URL('../', import.meta.url))
    const archive = join(home, 'snapshot.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', root, './install.sh', './setup-wsl.sh', './scripts', './lib', './package.json', './cordis.patch.yml'])
    const bin = join(home, 'bin')
    mkdirSync(bin)
    // Stand in for curl only; exercise real extraction and installer execution.
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\ncp "$TEST_ARCHIVE" "$4"\n')
    chmodSync(join(bin, 'curl'), 0o755)
    const source = readFileSync(entry, 'utf8')
    const options = {
      input: source, cwd: home, encoding: 'utf8' as const,
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, TEST_ARCHIVE: archive },
    }
    execFileSync('bash', ['-s', '--', 'install'], options)
    const installed = join(home, 'profiles/web/node_modules/dsh-telegram/lib/index.js')
    expect(existsSync(installed)).toBe(true)
    execFileSync('bash', ['-s', '--', 'uninstall'], options)
    expect(existsSync(installed)).toBe(false)
  })

  it('rejects unknown actions before writing profile files', () => {
    const { home, env } = fixture()
    const result = spawnSync('bash', [entry, 'remove'], { env, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })
})
