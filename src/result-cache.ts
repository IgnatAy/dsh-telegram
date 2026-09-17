import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** One replaceable, unsent complete output per bot/chat; never a history log. */
export class TelegramResultCache {
  private readonly queues = new Map<number, Promise<unknown>>()
  readonly directory: string

  constructor(token: string, directory?: string) {
    const configured = process.env.DSH_HOME || join(homedir(), '.dsh')
    const home = configured === '~' ? homedir()
      : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(configured)
    // Bot identity survives token rotation; never put the token in a file name.
    const bot = createHash('sha256').update(token.split(':')[0]!).digest('hex')
    this.directory = join(directory ?? join(home, 'telegram-results'), bot)
  }

  private async exclusive<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.queues.set(chatId, next)
    try { return await next }
    finally { if (this.queues.get(chatId) === next) this.queues.delete(chatId) }
  }

  private path(chatId: number): string {
    if (!Number.isSafeInteger(chatId)) throw new Error('Invalid Telegram chat id')
    return join(this.directory, `${chatId}.json`)
  }

  async deliver<T>(chatId: number, markdown: string, send: (text: string) => Promise<T>): Promise<T> {
    return this.exclusive(chatId, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = this.path(chatId)
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ markdown }), { mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      const result = await send(markdown)
      await rm(path, { force: true })
      return result
    })
  }

  async resend(chatId: number, send: (text: string) => Promise<unknown>): Promise<boolean> {
    return this.exclusive(chatId, async () => {
      const path = this.path(chatId)
      let raw: string
      try { raw = await readFile(path, 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null || !('markdown' in value)
        || typeof value.markdown !== 'string') throw new Error('Invalid Telegram result cache')
      await send(value.markdown)
      await rm(path, { force: true })
      return true
    })
  }
}
