import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** Public concrete JSONL capability; the abstract rc2 persistence service has no locator. */
interface JsonlPersistence extends SessionPersistence {
  resolveCurrentLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
}

const GENERATION = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u

export function requireJsonlPersistence(storage: SessionPersistence): JsonlPersistence {
  if (!('resolveCurrentLog' in storage) || typeof storage.resolveCurrentLog !== 'function') {
    throw new Error('当前持久化后端不支持 Telegram 的永久删除操作')
  }
  return storage as JsonlPersistence
}

/**
 * Delete all committed generations with rc2 write ownership held. Keep session.lock:
 * unlinking that inode would let another process bypass the kernel lock.
 * Move logs aside before detaching, restoring them if staging or detachment fails.
 */
export async function deleteSessionLogs(
  storage: JsonlPersistence,
  id: SessionId,
  detach: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  // A never-used Agent can close without ever materializing an empty session.
  if (await storage.stat(id, { signal }) === undefined) {
    await detach()
    return
  }
  const handle = await storage.open(id, 'write', { signal })
  try {
    const path = await storage.resolveCurrentLog(id, signal)
    if (path === undefined || !isAbsolute(path) || !GENERATION.test(basename(path))) {
      throw new Error('无法定位当前会话的版本日志，未删除任何文件')
    }
    const directory = dirname(path)
    const entries = await readdir(directory, { withFileTypes: true })
    const logs = entries.filter(entry => GENERATION.test(entry.name))
    if (logs.some(entry => !entry.isFile()) || !logs.some(entry => entry.name === basename(path))) {
      throw new Error('会话日志目录不符合预期，未删除任何文件')
    }
    // Hide historical generations first so a concurrent reader cannot fall back to one.
    logs.sort((a, b) => Number(a.name === basename(path)) - Number(b.name === basename(path)))
    const staging = await mkdtemp(join(directory, '.telegram-delete-'))
    const moved: string[] = []
    try {
      for (const entry of logs) {
        await rename(join(directory, entry.name), join(staging, entry.name))
        moved.push(entry.name)
      }
      await detach()
    } catch (error) {
      const failures: unknown[] = [error]
      for (const name of moved.reverse()) {
        try { await rename(join(staging, name), join(directory, name)) }
        catch (rollbackError) { failures.push(rollbackError) }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, `会话删除失败，部分日志保留在 ${staging}`)
      }
      await rm(staging, { recursive: true })
      throw error
    }
    await rm(staging, { recursive: true })
  } finally {
    await handle.close()
  }
}
