/**
 * DSH presentation rules adapted under the MIT License.
 * MIT License
 * 
 * Copyright (c) 2026 DeepSeek
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { escapeHtml } from './format.js'

/** Preserve Rich Markdown, but close unfinished fences/disclosures at each record boundary. */
export function richBody(text: string): string {
  let fence: { char: string, length: number } | undefined
  let depth = 0
  const lines = text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '') fence = undefined
      return line
    }
    if (fence) return line
    return line.replace(/<\/?details\b[^>]*>/gi, tag => {
      if (/^<\//.test(tag)) {
        if (depth === 0) return escapeHtml(tag)
        depth--
      } else depth++
      return tag
    })
  })
  if (fence) lines.push(fence.char.repeat(fence.length))
  if (depth) lines.push('\n' + '</details>'.repeat(depth))
  return lines.join('\n')
}

/** Retain visible assistant messages and counts only, never reasoning or tool payloads. */
export class TelegramTranscript {
  private readonly messages: { step: number, text: string, hasTools: boolean }[] = []
  private tools = 0
  private seen = false
  private step = 0

  event(event: SessionEvent): void {
    if (event.type === 'step/start') this.step = event.data.step
    if (event.type === 'tool/call') { this.tools++; this.seen = true }
    if (event.type !== 'assistant/message'
      || (event.surfaceOp !== undefined && event.surfaceOp !== 'append')) return
    this.seen = true
    this.messages.push({
      step: event.data.step ?? ++this.step,
      text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''),
      hasTools: event.data.message.content.some(block => block.type === 'tool-call'),
    })
  }

  get answer(): string { return this.messages.at(-1)?.text ?? '' }
  get hasEntries(): boolean { return this.seen }

  render(answer: string): string {
    const latest = this.messages.at(-1)
    const final = latest && answer === latest.text && answer.trim()
      && latest.step >= this.step && !latest.hasTools ? latest : undefined
    const intermediate = this.messages.filter(message => message.text.trim()
      && (final === undefined || message.step < final.step))
    if (!this.tools && !intermediate.length) return ''
    const summary = `${this.tools} 次工具调用 · ${intermediate.length} 条消息`
    // Keep Markdown at the top level inside details so tables, formulas and
    // code remain native; separators distinguish messages without extra labels.
    const body = intermediate.map(message => richBody(message.text)).join('\n\n---\n\n')
    return `<details><summary>${escapeHtml(summary)}</summary>\n\n${body || '暂无中间消息。'}\n\n</details>`
  }
}
