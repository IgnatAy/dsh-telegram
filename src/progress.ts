import { randomInt } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TelegramApiError } from './client.js'
import type { TelegramClientLike } from './client.js'
import { escapeHtml } from './format.js'
import { TelegramTranscript } from './transcript.js'

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
  private draftId = randomInt(1, 2 ** 31)
  private readonly started = Date.now()
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private readonly timer: NodeJS.Timeout
  private attempt: AssistantStreamFrame['attemptId'] | undefined
  private revision = -1
  private text = ''
  private previewOverflow = false
  private phase = '正在思考'
  private tools: ToolProgress[] = []
  private completed = 0
  private readonly transcript: TelegramTranscript
  private lastPublished = ''
  private paused = false
  private waitingForUser = false
  private disposed = false
  private stoppedByUser = false
  private scheduled = false
  private epoch = 0
  private dirty = true
  private nextSend = 0
  private lastSent = 0

  constructor(
    private readonly client: TelegramClientLike,
    private readonly chatId: number,
    signal: AbortSignal,
    private readonly enqueue: (task: () => Promise<void>) => Promise<void>,
    private readonly warn: (error: unknown) => void,
  ) {
    this.transcript = new TelegramTranscript()
    this.signal = AbortSignal.any([signal, this.abort.signal])
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
      this.previewOverflow = false
      this.phase = '正在思考'
      this.changed()
    } else if (frame.attemptId === this.attempt && frame.type === 'chunk') {
      if (frame.chunk.type === 'text-delta') {
        // Never truncate rich syntax: a missing closing tag/fence can leave an
        // unusable disclosure. Stop previewing this attempt once it is too long.
        if (!this.previewOverflow) {
          if (this.text.length + frame.chunk.text.length > 16000) {
            this.previewOverflow = true
            this.text = ''
          } else this.text += frame.chunk.text
        }
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
      this.previewOverflow = false
      this.phase = '正在等待重试'
      this.changed()
    }
  }

  event(event: SessionEvent): void {
    if (this.disposed) return
    this.transcript.event(event)
    if (event.type === 'tool/call') {
      // Keep active calls plus a bounded recent history.
      this.tools = this.tools.filter((tool, index) => tool.ended === undefined || index >= this.tools.length - 12)
      this.tools.push({ id: event.data.callId, name: clip(event.data.name, 80), started: event.time })
      this.text = ''
      this.previewOverflow = false
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
      this.previewOverflow = false
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
    if (reason === 'completed') return this.paused && this.transcript.answer.trim() ? undefined : '✅ **任务已完成**'
    if (reason === 'aborted' || reason === 'interrupted') return '⏹ **任务已中断**'
    if (reason === 'error') return '⚠️ **任务执行失败**，请检查 dsh 日志。'
    if (reason === 'blocked') return '⚠️ **任务暂时无法继续**'
    if (reason === 'max-tokens') return '⚠️ **输出已达到长度限制**'
    return 'ℹ️ **任务已结束**'
  }

  /** One rich message: folded intermediate messages followed by the answer. */
  finalMessages(text: string): string[] {
    const markdown = [this.processDetails(text), text].filter(part => part.trim()).join('\n\n')
    const messages = markdown ? [markdown] : []
    this.lastPublished = JSON.stringify(messages)
    return messages
  }

  /** Include late tool results and reasoning-only turns in the terminal delivery. */
  finishMessages(notice?: string): string[] | undefined {
    if (this.stoppedByUser || !this.transcript.hasEntries) return undefined
    const previous = this.lastPublished
    const result = this.finalMessages(notice ?? this.transcript.answer)
    return this.lastPublished === previous ? undefined : result
  }

  private processDetails(answer: string): string {
    return this.transcript.render(answer)
  }

  private toolLines(): string[] {
    return this.tools.slice(-12).map(tool => {
      const seconds = Math.max(0, Math.round(((tool.ended ?? Date.now()) - tool.started) / 1000))
      return `${tool.ended === undefined ? '⏳' : tool.failed ? '❌' : '✅'} ${tool.name} · ${seconds} 秒`
    })
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
    // Reusing an ID animates every rewrite, including the changing status and
    // tool header. Replace snapshots without replaying that typing animation.
    this.draftId = this.draftId % (2 ** 31 - 1) + 1
    // Partial disclosures may have only a summary (or an unfinished body).
    // Leave them to committed delivery, where the complete source is available.
    const preview = this.previewOverflow ? '回复较长，完整内容将在本段生成完成后显示。'
      : /<\/?(?:details|summary)\b/i.test(this.text) ? '折叠内容将在本段生成完成后显示。'
      : this.text
    const lines = [status, ...(this.tools.length ? [`已完成 ${this.completed} 次工具调用`, ...this.toolLines()] : [])]
    await this.client.sendRichMessageDraft(this.chatId, this.draftId,
      `<tg-thinking>${lines.map(escapeHtml).join('<br>')}</tg-thinking>\n\n${preview}`, this.signal)
  }
}
