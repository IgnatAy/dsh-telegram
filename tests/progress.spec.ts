import { richExamples } from './fixtures/rich-markdown.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TelegramApiError } from '../src/client.ts'
import type { TelegramClientLike } from '../src/client.ts'
import { TelegramProgress } from '../src/progress.ts'

let progress: TelegramProgress | undefined
afterEach(() => { progress?.dispose(); progress = undefined; vi.useRealTimers() })

function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(100000)
  const client = {
    sendRichMessageDraft: vi.fn(async () => true),
    sendRichMessage: vi.fn(),
    sendMessage: vi.fn(async () => ({ message_id: 42 })),
    editMessageText: vi.fn(async () => ({ message_id: 42 })),
  }
  let queue = Promise.resolve()
  const warn = vi.fn()
  progress = new TelegramProgress(client as unknown as TelegramClientLike, 7, new AbortController().signal,
    task => { queue = queue.then(task); return queue }, warn)
  return { client, warn, drain: () => queue, p: progress }
}

function start(p: TelegramProgress, attemptId = 'a', revision = 1) {
  p.stream({ type: 'start', attemptId, revision, turn: 1, step: 1 } as AssistantStreamFrame)
}

function chunk(p: TelegramProgress, text: string, revision: number, attemptId = 'a') {
  p.stream({ type: 'chunk', attemptId, revision, index: revision - 2, time: Date.now(),
    chunk: { type: 'text-delta', index: 0, text } } as AssistantStreamFrame)
}

describe('TelegramProgress', () => {
  it('folds intermediate messages and counts without reasoning or tool details', () => {
    const { p } = setup()
    const assistant = (content: unknown[]) => p.event({ type: 'assistant/message', data: { message: { content } } } as SessionEvent)
    assistant([{ type: 'reasoning', text: '先检查 <details> & 状态' }, { type: 'text', text: '正在检查' }])
    p.event({ type: 'tool/call', time: 100000, data: { callId: 'a', name: 'read', arguments: '{"path":"a.ts"}' } } as SessionEvent)
    p.event({ type: 'tool/result', time: 101000, data: { message: { content: [
      { type: 'tool-result', toolCallId: 'a', isError: true, content: [{ type: 'text', text: '文件不存在' }] },
    ] } } } as SessionEvent)
    assistant([{ type: 'reasoning', text: '整理结果' }, { type: 'text', text: '**最终答案**' }])
    const result = p.finalMessages('**最终答案**').join('\n\n')
    expect(result).not.toContain('先检查 &lt;details&gt; &amp; 状态')
    expect(result).toContain('正在检查')
    expect(result).not.toContain('```json\n{\n  \"path\": \"a.ts\"\n}\n```')
    expect(result).not.toContain('读取 · 文件不存在')
    expect(result).not.toContain('文件不存在')
    expect(result).not.toContain('整理结果')
    expect(result.match(/最终答案/g)).toHaveLength(1)
    expect(result).toMatch(/<\/details>\n\n\*\*最终答案\*\*$/)
    expect(result).not.toContain('<details open')
    expect(p.finishMessages()).toBeUndefined()
  })

  it('omits empty messages when only an answer or process record exists', () => {
    const { p } = setup()
    expect(p.finalMessages('只有正文')).toEqual(['只有正文'])
    p.event({ type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '只有思考' },
    ] } } } as SessionEvent)
    const messages = p.finalMessages('')
    expect(messages).toEqual([])
  })

  it('retains all committed steps, but never abandoned streaming attempts', () => {
    const { p } = setup()
    start(p)
    chunk(p, '丢弃的草稿', 2)
    for (let i = 0; i < 20; i++) {
      p.event({ type: 'assistant/message', data: { message: { content: [
        { type: 'text', text: `步骤 ${i}` },
      ] } } } as SessionEvent)
    }
    const result = p.finalMessages('步骤 19').join('\n\n')
    expect(result).toContain('步骤 0')
    expect(result).toContain('步骤 18')
    expect(result).not.toContain('丢弃的草稿')
    expect(result.match(/步骤 19/g)).toHaveLength(1)
  })

  it('includes reasoning-only turns and results arriving after the last answer', () => {
    const { p } = setup()
    p.event({ type: 'assistant/message', data: { message: { content: [
      { type: 'reasoning', text: '已确认的思考' },
    ] } } } as SessionEvent)
    expect(p.finishMessages('任务已完成')).toEqual(['任务已完成'])
    p.event({ type: 'tool/result', time: 101000, data: { message: { content: [
      { type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: '迟到的结果' }] },
    ] } } } as SessionEvent)
    expect(p.finishMessages('任务已完成')).toBeUndefined()
    p.stopByUser()
    expect(p.finishMessages('任务已完成')?.join('\n\n')).toBeUndefined()
  })

  it('aborts an in-flight draft on disposal so final delivery can proceed', async () => {
    const { p, client, drain } = setup()
    client.sendRichMessageDraft.mockImplementationOnce((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = args[3] as AbortSignal
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(1)
    p.dispose()
    await drain()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves code source for the native rich parser', () => {
    const { p } = setup()
    const html = p.finalMessages('Before\n\n```ts\nconst a = 1\n```\n\nAfter').join('\n\n')
    expect(html).toBe('Before\n\n```ts\nconst a = 1\n```\n\nAfter')
    expect(html).not.toContain('<p><pre>')
    expect(html).toContain('After')
  })

  it('uses native formatting for both streamed previews and persisted replies', async () => {
    const { p, client, drain } = setup()
    const text = '# 标题\n\n| 项目 | 说明 |\n|---|---|\n| 粗体 | **正常** |\n\n---'
    start(p)
    chunk(p, text, 2)
    await drain()
    const final = p.finalMessages(text).join('\n\n')
    expect(final).toBe(text)
    expect(final).toContain('# 标题')
    expect(final).toContain('---')
    expect(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).toContain(final)
    expect(final).not.toContain('<pre>')
  })

  it('preserves every streamed formula prefix and does not append metadata inside unfinished code', async () => {
    const { p, client, drain } = setup()
    p.event({ type: 'tool/call', time: 100000, data: { callId: 'a', name: 'read<file>', arguments: '{}' } } as SessionEvent)
    start(p)
    let prefix = ''
    let revision = 2
    for (const part of ['公式 $', String.raw`\frac{`, '1}{2}', '$']) {
      prefix += part
      chunk(p, part, revision++)
      await vi.advanceTimersByTimeAsync(1200)
      await drain()
      expect(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).toContain(prefix)
    }
    const code = '```html\n<details>source'
    expect(p.finalMessages(code)[0]?.endsWith(code)).toBe(true)
    expect(p.finalMessages(code).join('\n\n')).not.toContain('read&lt;file&gt;')
    for (const [, source] of richExamples) expect(p.finalMessages(source)[0]?.endsWith(source)).toBe(true)
  })

  it('combines tool counts and answer in one message without large tool output', () => {
    const { p } = setup()
    const log = '详细工具输出\n'.repeat(2000)
    p.event({ type: 'tool/call', time: 100000, data: { callId: 'a', name: 'read', arguments: '{}' } } as SessionEvent)
    p.event({ type: 'tool/result', time: 101000, data: { message: { content: [
      { type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: log }] },
    ] } } } as SessionEvent)
    p.event({ type: 'assistant/message', data: { message: { content: [
      { type: 'text', text: '这是最终正文。' },
    ] } } } as SessionEvent)
    const result = p.finalMessages('这是最终正文。').join('\n\n')
    expect(p.finalMessages('这是最终正文。')).toHaveLength(1)
    expect(result.endsWith('</details>\n\n这是最终正文。')).toBe(true)
    expect(p.finalMessages('这是最终正文。')[0]).toMatch(/^<details>/)
    expect(result).not.toContain(log)
    expect(result).toContain('1 次工具调用 · 0 条消息')
    expect(result.match(/<details>/g)).toHaveLength(1)
    expect(result.match(/这是最终正文。/g)).toHaveLength(1)
    expect(p.finishMessages()).toBeUndefined()
  })

  it('places the process disclosure before an unfinished answer', () => {
    const { p } = setup()
    p.event({ type: 'tool/call', time: 100000, data: { callId: 'a', name: 'read', arguments: '{}' } } as SessionEvent)
    const answer = '<details><summary>说明</summary>\n\n正文'
    const messages = p.finalMessages(answer)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/^<details><summary>1 次工具调用/)
    expect(messages[0]?.endsWith('</details>\n\n' + answer)).toBe(true)
  })

  it('keeps the other tool running when parallel results arrive out of order', async () => {
    const { p, client, drain } = setup()
    for (const callId of ['a', 'b']) {
      p.event({ type: 'tool/call', time: 100000, data: { callId, name: `tool-${callId}`, arguments: '{}' } } as SessionEvent)
    }
    p.event({ type: 'tool/result', time: 101000, data: { message: { content: [
      { type: 'tool-result', toolCallId: 'b', content: [] },
    ] } } } as SessionEvent)
    await drain()
    const html = client.sendRichMessageDraft.mock.calls.at(-1)?.[2]
    expect(html).toContain('正在执行工具：tool-a')
    expect(html).toContain('✅ tool-b')
  })

  it('coalesces tokens and replaces snapshots without animation, refreshing before expiry', async () => {
    const { p, client, drain } = setup()
    start(p)
    await drain()
    for (let i = 0; i < 100; i++) chunk(p, '字', i + 2)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1200)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(2)
    expect(client.sendRichMessageDraft.mock.calls[1]?.[2]).toContain('字'.repeat(100))
    await vi.advanceTimersByTimeAsync(12000)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(3)
    const ids = client.sendRichMessageDraft.mock.calls.map(call => call[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => Number.isInteger(id) && Number(id) > 0)).toBe(true)
  })

  it('clears a retried attempt and ignores stale chunks and duplicate revisions', async () => {
    const { p, client, drain } = setup()
    start(p)
    chunk(p, '旧答案', 2)
    await drain()
    start(p, 'b', 3)
    chunk(p, '迟到旧内容', 2)
    chunk(p, '新答案', 4, 'b')
    chunk(p, '重复', 4, 'b')
    await vi.advanceTimersByTimeAsync(1200)
    const html = client.sendRichMessageDraft.mock.calls.at(-1)?.[2]
    expect(html).toContain('新答案')
    expect(html).not.toMatch(/旧答案|迟到|重复/)
  })

  it('keeps drafts compact and folds tool arguments and results into final delivery', async () => {
    const { p, client, drain } = setup()
    start(p)
    p.stream({ type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 100000,
      chunk: { type: 'tool-call-delta', id: 't', index: 0, name: 'bash', argumentsDelta: 'secret' } } as AssistantStreamFrame)
    await drain()
    expect(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).toContain('正在准备工具调用')
    p.event({ type: 'tool/call', time: 100000, data: { callId: 't', name: 'bash<script>', arguments: 'secret' } } as SessionEvent)
    await vi.advanceTimersByTimeAsync(1200)
    expect(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).toContain('正在执行工具')
    p.event({ type: 'tool/result', time: 102000, data: { message: { content: [
      { type: 'tool-result', toolCallId: 't', isError: true, content: [{ type: 'text', text: 'secret result' }] },
    ] } } } as SessionEvent)
    const final = p.finalMessages('完成').join('\n\n')
    expect(final).toContain('<details>')
    expect(final).not.toContain('工具调用 · secret result')
    expect(final).not.toContain('secret result')
  })

  it('reports a rejected native preview without creating legacy preview messages', async () => {
    const { p, client, drain, warn } = setup()
    const error = new TelegramApiError('invalid rich content', 400)
    client.sendRichMessageDraft.mockRejectedValueOnce(error)
    await drain()
    expect(warn).toHaveBeenCalledWith(error)
    await vi.advanceTimersByTimeAsync(6000)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(2)
    expect(client.sendMessage).not.toHaveBeenCalled()
    expect(client.editMessageText).not.toHaveBeenCalled()
    expect(p.finalMessages('完整答案').join('\n\n')).toContain('完整答案')
  })

  it('honors retry_after while continuing to coalesce and keeps native mode', async () => {
    const { p, client, drain } = setup()
    client.sendRichMessageDraft.mockRejectedValueOnce(new TelegramApiError('rate limited', 429, 5))
    start(p)
    await drain()
    chunk(p, '最新', 2)
    await vi.advanceTimersByTimeAsync(4800)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1200)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(2)
    expect(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).toContain('最新')
  })

  it('does not downgrade on ambiguous network errors', async () => {
    const { client, drain } = setup()
    client.sendRichMessageDraft.mockRejectedValueOnce(new Error('network unavailable'))
    await drain()
    await vi.advanceTimersByTimeAsync(6000)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(2)
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it('invalidates queued previews at finalization and releases the timer on disposal', async () => {
    const { p, client, drain } = setup()
    start(p)
    chunk(p, '部分', 2)
    p.pause()
    await drain()
    await vi.advanceTimersByTimeAsync(24000)
    expect(client.sendRichMessageDraft).not.toHaveBeenCalled()
    p.resume()
    await drain()
    p.dispose()
    chunk(p, '迟到', 3)
    await vi.advanceTimersByTimeAsync(24000)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not resume previews over a pending user question', async () => {
    const { p, client, drain } = setup()
    await drain()
    p.suspend()
    p.event({ type: 'tool/call', time: 100000, data: { callId: 'parallel', name: 'read', arguments: '{}' } } as SessionEvent)
    await vi.advanceTimersByTimeAsync(24000)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(1)
    p.resume()
    await drain()
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(2)
  })

  it('caps previews without downgrading or truncating long final answers', async () => {
    const { p, client, drain } = setup()
    start(p)
    chunk(p, '中'.repeat(100000), 2)
    await drain()
    expect(String(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).length).toBeLessThan(20000)
    expect(p.finalMessages('中'.repeat(25000)).join('\n\n')).toBe('中'.repeat(25000))
  })

  it('defers disclosures until committed delivery and keeps tool status outside disclosures', async () => {
    const { p, client, drain } = setup()
    p.event({ type: 'tool/call', time: 100000, data: { callId: 'a', name: 'read', arguments: '{}' } } as SessionEvent)
    start(p)
    chunk(p, '<details><summary>摘要</summary>', 2)
    await drain()
    const preview = String(client.sendRichMessageDraft.mock.calls.at(-1)?.[2])
    expect(preview).not.toContain('<details>')
    expect(preview).toContain('折叠内容将在本段生成完成后显示')
    expect(preview).toContain('⏳ read')
    const complete = '<details><summary>摘要</summary>\n\n正文\n\n</details>'
    expect(p.finalMessages(complete).join('\n\n')).toContain(complete)
  })

  it('does not send truncated rich syntax or resume its tail after overflowing', async () => {
    const { p, client, drain } = setup()
    start(p)
    chunk(p, '<details><summary>摘要</summary>' + '字'.repeat(17000), 2)
    await drain()
    chunk(p, '</details>尾部', 3)
    await vi.advanceTimersByTimeAsync(1200)
    const preview = String(client.sendRichMessageDraft.mock.calls.at(-1)?.[2])
    expect(preview).toContain('回复较长')
    expect(preview).not.toMatch(/<\/?details>|尾部|字/)
    start(p, 'b', 4)
    chunk(p, '重试回复', 5, 'b')
    await vi.advanceTimersByTimeAsync(1200)
    expect(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).toContain('重试回复')
  })
})
