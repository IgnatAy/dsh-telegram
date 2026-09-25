import { randomInt } from 'node:crypto'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TelegramApiError } from './client.js'
import type { TelegramClientLike } from './client.js'
import { escapeHtml } from './format.js'
import { richBody, TelegramTranscript } from './transcript.js'

const LONG_PREVIEW = '回复较长，完整内容将在任务结束后显示。'

function previewText(text: string, overflow: boolean): string {
  return overflow ? LONG_PREVIEW
    : /<\/?(?:details|summary)\b/i.test(text) ? '折叠内容将在任务结束后显示。'
    : text
}

/**
 * One turn's disposable preview. Events mutate bounded state synchronously; a
 * coalescer sends only the latest snapshot through the bridge's delivery queue.
 * No tool arguments or result bodies are copied into the preview.
 */
export class TelegramProgress {
  private readonly draftId = randomInt(1, 2 ** 31)
  private readonly started = Date.now()
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private readonly timer: NodeJS.Timeout
  private attempt: AssistantStreamFrame['attemptId'] | undefined
  private revision = -1
  private text = ''
  private committedPreview = ''
  private committedOverflow = false
  private previewOverflow = false
  private phase = '正在思考'
  private readonly activeTools = new Set<string>()
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
    if (event.type === 'assistant/message') {
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return
      // Transfer the authoritative message into the preview history exactly
      // once. Status changes and new attempts must not erase completed steps.
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      const body = richBody(previewText(text, text.length > 16000))
      const combined = [this.committedPreview, body].filter(part => part.trim()).join('\n\n---\n\n')
      if (!this.committedOverflow) {
        if (combined.length > 16000) this.committedOverflow = true
        else this.committedPreview = combined
      }
      this.text = ''
      this.previewOverflow = false
      this.attempt = undefined
      this.changed()
    } else if (event.type === 'tool/call') {
      this.activeTools.add(event.data.callId)
      this.phase = '正在执行工具'
      this.changed()
    } else if (event.type === 'tool/result') {
      for (const block of event.data.message.content) {
        if (block.type !== 'tool-result') continue
        this.activeTools.delete(block.toolCallId)
      }
      this.phase = this.activeTools.size ? '正在执行工具' : '正在整理工具结果'
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
    if (reason === 'completed') return this.transcript.answer.trim() ? undefined : '✅ **任务已完成**'
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

  private status(): string {
    return `${this.phase} · ${Math.floor((Date.now() - this.started) / 1000)} 秒`
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
    // One stable draft per turn: replacing its ID makes Telegram remove and
    // recreate the preview on every update.
    // Partial disclosures may have only a summary (or an unfinished body).
    // Leave them to committed delivery, where the complete source is available.
    let current = previewText(this.text, this.previewOverflow)
    if (this.committedOverflow || this.committedPreview.length + current.length > 16000) current = LONG_PREVIEW
    const preview = [
      this.committedPreview.trim() ? `### 处理进展\n\n${this.committedPreview}` : '',
      current.trim() ? `### 正在生成\n\n${richBody(current)}` : '',
    ].filter(Boolean).join('\n\n---\n\n')
    await this.client.sendRichMessageDraft(this.chatId, this.draftId,
      `<tg-thinking>${escapeHtml(status)}</tg-thinking>\n\n${preview}`, this.signal)
  }
}
