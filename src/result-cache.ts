import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** One replaceable complete output per bot/chat; retained for display recovery. */
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

  async deliver<T>(chatId: number, markdown: string | string[], send: (text: string) => Promise<T>): Promise<void> {
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
      // API acceptance does not guarantee that a client rendered the message.
      for (const text of typeof markdown === 'string' ? [markdown] : markdown) await send(text)
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
        || !(typeof value.markdown === 'string' || (Array.isArray(value.markdown)
          && value.markdown.every(text => typeof text === 'string')))) throw new Error('Invalid Telegram result cache')
      const messages: string[] = typeof value.markdown === 'string' ? [value.markdown] : value.markdown
      for (const text of messages) await send(text)
      return true
    })
  }
}
