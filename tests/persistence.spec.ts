import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteSessionLogs, requireJsonlPersistence } from '../src/persistence.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(compression: 'none' | 'zstd' = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'telegram-rc2-'))
  directories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  await ctx.plugin(SessionQuery)
  const storage = requireJsonlPersistence(ctx.sessionPersistence)
  const id = SessionId('telegram:7:rc2')
  const writer = await storage.create({
    id, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: root,
    isSeeded: false, delegationDepth: 0,
  })
  await writer.flush()
  await writer.close()
  const path = (await storage.resolveCurrentLog(id))!
  return { ctx, storage, id, path, root, signal: new AbortController().signal }
}

describe('rc2 JSONL persistence integration', () => {
  it('observes a healthy cold session even when another stored header breaks corpus listing', async () => {
    const { ctx, storage, id, root } = await setup()
    const brokenId = SessionId('broken-history')
    const writer = await storage.create({
      id: brokenId, version: SESSION_FORMAT_VERSION, createdAt: 2, cwd: root,
      isSeeded: false, delegationDepth: 0,
    })
    await writer.flush()
    await writer.close()
    const brokenPath = (await storage.resolveCurrentLog(brokenId))!
    const header = JSON.parse(await readFile(brokenPath, 'utf8'))
    await writeFile(brokenPath, JSON.stringify({ ...header, id: 'wrong-id' }) + '\n')
    await expect(ctx.sessionQuery.listSessions()).rejects.toThrow()
    const observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
    try {
      expect(observation.header.id).toBe(id)
      expect(observation.source).toBe('prepared')
      expect(observation.events).toEqual([])
    } finally {
      observation[Symbol.dispose]()
    }
  })

  it.each(['none', 'zstd'] as const)('deletes every generation (%s), keeps the lock inode, and stays deleted after reopening', async compression => {
    const { ctx, storage, id, path, root, signal } = await setup(compression)
    const dir = dirname(path)
    const suffix = compression === 'zstd' ? '.zstd' : ''
    // Older generations are ignored while the current generation exists. They
    // must disappear as well, or rc2 will migrate and resurrect the session.
    await writeFile(join(dir, `session.jsonl${suffix}`), 'historical log')
    await writeFile(join(dir, `session.v2.jsonl${suffix}`), 'historical log')
    await writeFile(join(dir, 'notes.txt'), 'unrelated data')
    const lock = join(dir, 'session.lock')
    const inode = (await stat(lock)).ino
    const detach = vi.fn(async () => {})
    await deleteSessionLogs(storage, id, detach, signal)
    expect(detach).toHaveBeenCalledOnce()
    expect((await readdir(dir)).sort()).toEqual(['notes.txt', 'session.lock'])
    expect((await stat(lock)).ino).toBe(inode)
    expect(await storage.stat(id)).toBeUndefined()
    expect(await storage.list()).toEqual([])
    await expect(ctx.sessionQuery.observeSession(id)).rejects.toThrow()

    const reopened = new Context()
    contexts.push(reopened)
    await reopened.plugin(JsonlSessionPersistence, { root, compression })
    expect(await reopened.sessionPersistence.list()).toEqual([])
  })

  it('restores all generations when workspace detachment fails', async () => {
    const { storage, id, path, signal } = await setup()
    const original = await readFile(path)
    const oldPath = join(dirname(path), 'session.v2.jsonl')
    await writeFile(oldPath, 'historical log')
    await expect(deleteSessionLogs(storage, id, async () => { throw new Error('workspace write failed') }, signal))
      .rejects.toThrow('workspace write failed')
    expect(await readFile(path)).toEqual(original)
    expect(await readFile(oldPath, 'utf8')).toBe('historical log')
    expect((await readdir(dirname(path))).some(name => name.startsWith('.telegram-delete-'))).toBe(false)
    const writer = await storage.open(id, 'write')
    await writer.close()
  })

  it('does not delete or detach while another rc2 instance owns the writer', async () => {
    const { storage, id, path, root, signal } = await setup()
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const writer = await other.sessionPersistence.open(id, 'write')
    const detach = vi.fn(async () => {})
    try {
      await expect(deleteSessionLogs(storage, id, detach, signal)).rejects.toThrow()
      expect(detach).not.toHaveBeenCalled()
      expect(await readFile(path, 'utf8')).toContain(String(id))
    } finally {
      await writer.close()
    }
  })

  it('detaches a never-materialized empty session', async () => {
    const { storage, signal } = await setup()
    const id = SessionId('telegram:7:empty')
    const handle = await storage.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 2, isSeeded: false, delegationDepth: 0 })
    await handle.close()
    const detach = vi.fn(async () => {})
    await deleteSessionLogs(storage, id, detach, signal)
    expect(detach).toHaveBeenCalledOnce()
    expect(await storage.stat(id)).toBeUndefined()
  })
})
