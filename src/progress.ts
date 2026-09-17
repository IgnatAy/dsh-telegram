import { randomInt } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TelegramApiError } from './client.js'
import type { TelegramClientLike } from './client.js'
import { escapeHtml, markdownToHtml } from './format.js'

interface ToolProgress {
  id: string
  name: string
  started: number
  ended?: number
  failed?: boolean
}

/** Bound preview text without cutting a UTF-16 surrogate pair. Final answers are never clipped. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  let end = limit - 1
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--
  return `${text.slice(0, end)}…`
}

/**
 * One turn's disposable preview. Events mutate bounded state synchronously; a
 * coalescer sends only the latest snapshot through the bridge's delivery queue.
 * No tool arguments or result bodies are copied into the preview.
 */
export class TelegramProgress {
  readonly draftId = randomInt(1, 2 ** 31)
  private readonly started = Date.now()
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private readonly timer: NodeJS.Timeout
  private attempt: AssistantStreamFrame['attemptId'] | undefined
  private revision = -1
  private text = ''
  private phase = '正在思考'
  private tools: ToolProgress[] = []
  private completed = 0
  private paused = false
  private waitingForUser = false
  private disposed = false
  private stoppedByUser = false
  private scheduled = false
  private epoch = 0
  private dirty = true
  private nextSend = 0
  private lastSent = 0
  private fallbackMessage: number | undefined
  private mode: 'rich' | 'draft' | 'edit'

  constructor(
    private readonly client: TelegramClientLike,
    private readonly chatId: number,
    signal: AbortSignal,
    private readonly enqueue: (task: () => Promise<void>) => Promise<void>,
    private readonly track: (messageId: number) => void,
    private readonly warn: (error: unknown) => void,
    private readonly maxLength = 4096,
  ) {
    this.signal = AbortSignal.any([signal, this.abort.signal])
    this.mode = client.sendRichMessageDraft === undefined ? 'draft' : 'rich'
    this.timer = setInterval(() => this.schedule(), 1200)
    this.schedule()
  }

  /** Reject old attempts and revisions, including late chunks after a retry. */
  stream(frame: AssistantStreamFrame): void {
    if (this.disposed || frame.revision <= this.revision) return
    this.revision = frame.revision
    if (frame.type === 'start') {
      this.attempt = frame.attemptId
      this.text = ''
      this.phase = '正在思考'
      this.changed()
    } else if (frame.attemptId === this.attempt && frame.type === 'chunk') {
      if (frame.chunk.type === 'text-delta') {
        this.text = clip(this.text + frame.chunk.text, 16000)
        this.phase = '正在生成回复'
      } else if (frame.chunk.type === 'reasoning-delta') {
        this.phase = '正在思考'
      } else if (frame.chunk.type === 'tool-call-delta') {
        this.phase = '正在准备工具调用'
      } else return
      this.changed()
    } else if (frame.attemptId === this.attempt && frame.type === 'end'
      && (frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt')) {
      this.text = ''
      this.phase = '正在等待重试'
      this.changed()
    }
  }

  event(event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'tool/call') {
      // Keep active calls plus a bounded recent history.
      this.tools = this.tools.filter((tool, index) => tool.ended === undefined || index >= this.tools.length - 12)
      this.tools.push({ id: event.data.callId, name: clip(event.data.name, 80), started: event.time })
      this.text = ''
      this.phase = '正在执行工具'
      this.changed()
    } else if (event.type === 'tool/result') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-result') continue
        const tool = this.tools.find(tool => tool.id === block.toolCallId && tool.ended === undefined)
        if (tool !== undefined) {
          tool.ended = event.time
          tool.failed = block.isError === true
          this.completed++
        }
      }
      this.phase = this.tools.some(tool => tool.ended === undefined) ? '正在执行工具' : '正在整理工具结果'
      this.changed()
    } else if (event.type === 'step/start') {
      this.text = ''
      this.phase = `正在思考 · 第 ${event.data.step} 步`
      this.changed()
    }
  }

  private changed(): void {
    this.paused = this.waitingForUser
    this.dirty = true
    this.schedule()
  }

  /** Invalidate queued previews before a persisted assistant message or user question. */
  pause(): void {
    this.paused = true
    this.epoch++
  }

  suspend(): void {
    this.waitingForUser = true
    this.pause()
  }

  resume(): void {
    this.waitingForUser = false
    if (!this.disposed) this.changed()
  }

  dispose(): void {
    this.disposed = true
    this.pause()
    clearInterval(this.timer)
    this.abort.abort()
  }

  stopByUser(): void {
    this.stoppedByUser = true
    this.dispose()
  }

  /** A terminal message clears a tool-only/failed draft even without an assistant answer. */
  terminalNotice(reason: string): string | undefined {
    if (this.stoppedByUser) return undefined
    if (reason === 'completed') return this.paused ? undefined : '✅ **任务已完成**'
    if (reason === 'aborted' || reason === 'interrupted') return '⏹ **任务已中断**'
    if (reason === 'error') return '⚠️ **任务执行失败**，请检查 dsh 日志。'
    if (reason === 'blocked') return '⚠️ **任务暂时无法继续**'
    if (reason === 'max-tokens') return '⚠️ **输出已达到长度限制**'
    return 'ℹ️ **任务已结束**'
  }

  /** Native stops must match this live draft, not a previous turn or another topic. */
  acceptsStop(draftId: number): boolean {
    return !this.disposed && !this.paused && this.mode !== 'edit' && draftId === this.draftId
  }

  /** Rich final content keeps recent tool outcomes in a collapsed section. */
  finalHtml(text: string): string | undefined {
    if (this.mode !== 'rich' || this.client.sendRichMessage === undefined || text.length > 24000) return undefined
    const body = markdownToHtml(text).split(/(<pre>[\s\S]*?<\/pre>)/g)
      .filter(Boolean).map(part => part.startsWith('<pre>') ? part : `<p>${part.replace(/\n/g, '<br>')}</p>`).join('')
    return `${body}${this.details()}`
  }

  private toolLines(): string[] {
    return this.tools.slice(-12).map(tool => {
      const seconds = Math.max(0, Math.round(((tool.ended ?? Date.now()) - tool.started) / 1000))
      return `${tool.ended === undefined ? '⏳' : tool.failed ? '❌' : '✅'} ${tool.name} · ${seconds} 秒`
    })
  }

  private details(): string {
    if (this.tools.length === 0) return ''
    return `<details><summary>运行记录 · 已完成 ${this.completed} 次工具调用</summary><p>${this.toolLines().map(escapeHtml).join('<br>')}</p></details>`
  }

  private status(): string {
    const active = this.tools.filter(tool => tool.ended === undefined).map(tool => tool.name).slice(0, 3)
    return `${this.phase}${active.length === 0 ? '' : `：${active.join('、')}`} · ${Math.floor((Date.now() - this.started) / 1000)} 秒`
  }

  private schedule(): void {
    if (this.disposed || this.paused || this.scheduled || Date.now() < this.nextSend
      || (!this.dirty && Date.now() - this.lastSent < 12000)) return
    this.scheduled = true
    const epoch = this.epoch
    void this.enqueue(async () => {
      try {
        if (this.disposed || this.paused || epoch !== this.epoch || this.signal.aborted) return
        this.dirty = false
        await this.send()
        this.lastSent = Date.now()
        this.nextSend = Date.now() + 1200
      } catch (error) {
        if (this.signal.aborted) return
        this.dirty = true
        if (error instanceof TelegramApiError && error.code === 429) {
          const delay = Number.isFinite(error.retryAfter) ? Math.max(1, error.retryAfter!) : 5
          this.nextSend = Date.now() + delay * 1000
        } else if (error instanceof TelegramApiError && (error.code === 400 || error.code === 404) && this.mode !== 'edit') {
          this.mode = this.mode === 'rich' && this.client.sendMessageDraft !== undefined ? 'draft' : 'edit'
          this.nextSend = Date.now() + 1200
        } else if (/not modified/i.test(String(error))) {
          this.nextSend = Date.now() + 1200
        } else {
          this.nextSend = Date.now() + 5000
          this.warn(error)
        }
      } finally {
        this.scheduled = false
      }
    })
  }

  private async send(): Promise<void> {
    const status = this.status()
    if (this.mode === 'rich' && this.client.sendRichMessageDraft !== undefined) {
      await this.client.sendRichMessageDraft(this.chatId, this.draftId,
        `<tg-thinking>${escapeHtml(status)}</tg-thinking>${this.details()}${this.text ? `<p>${escapeHtml(this.text).replace(/\n/g, '<br>')}</p>` : ''}`, this.signal)
      return
    }
    const text = clip(`${status}\n${this.toolLines().join('\n')}${this.text ? `\n\n${this.text}` : ''}`, this.maxLength)
    if (this.mode === 'draft' && this.client.sendMessageDraft !== undefined) {
      await this.client.sendMessageDraft(this.chatId, this.draftId, text, this.signal)
    } else {
      this.mode = 'edit'
      if (this.fallbackMessage === undefined) {
        try {
          const sent = await this.client.sendMessage(this.chatId, text, undefined, this.signal)
          this.fallbackMessage = sent.message_id
          this.track(sent.message_id)
        } catch (error) {
          // Without a message id, retrying an ambiguous send could create an
          // unbounded trail of duplicate previews. Keep final delivery available.
          if (!(error instanceof TelegramApiError) || error.code >= 500) {
            if (!this.signal.aborted) this.warn(error)
            this.dispose()
          }
          throw error
        }
      } else {
        try {
          await this.client.editMessageText(this.chatId, this.fallbackMessage, text, undefined, this.signal)
        } catch (error) {
          if (/message to edit not found|message can't be edited/i.test(String(error))) this.fallbackMessage = undefined
          throw error
        }
      }
    }
  }
}
