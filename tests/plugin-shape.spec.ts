import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as telegram from '../src/index.ts'

/**
 * Run the real namespace export through `Loader.unwrapExports`; a stray
 * default would discard `name`, `inject`, `Config`, and `apply`.
 */
describe('dsh-telegram plugin export shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    expect('default' in telegram).toBe(false)
    expect(typeof telegram.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(telegram) as Record<string, unknown>
    expect(unwrapped).toBe(telegram)
    expect(unwrapped.name).toBe('telegram')
    expect(unwrapped.inject).toEqual([
      'agents',
      'agentPresets',
      'attachments',
      'llm',
      'sessionController',
      'sessionPersistence',
      'sessionQuery',
      'systemPrompt',
      'workspaceRegistry',
    ])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
