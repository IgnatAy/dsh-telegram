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
    sendMessageDraft: vi.fn(async () => true),
    sendRichMessage: vi.fn(),
    sendMessage: vi.fn(async () => ({ message_id: 42 })),
    editMessageText: vi.fn(async () => ({ message_id: 42 })),
  }
  let queue = Promise.resolve()
  const track = vi.fn()
  const warn = vi.fn()
  progress = new TelegramProgress(client as unknown as TelegramClientLike, 7, new AbortController().signal,
    task => { queue = queue.then(task); return queue }, track, warn)
  return { client, track, warn, drain: () => queue, p: progress }
}

function start(p: TelegramProgress, attemptId = 'a', revision = 1) {
  p.stream({ type: 'start', attemptId, revision, turn: 1, step: 1 } as AssistantStreamFrame)
}

function chunk(p: TelegramProgress, text: string, revision: number, attemptId = 'a') {
  p.stream({ type: 'chunk', attemptId, revision, index: revision - 2, time: Date.now(),
    chunk: { type: 'text-delta', index: 0, text } } as AssistantStreamFrame)
}

describe('TelegramProgress', () => {
  it('does not resend an ordinary fallback preview after an ambiguous send failure', async () => {
    const { p, client, drain } = setup()
    client.sendRichMessageDraft.mockRejectedValueOnce(new TelegramApiError('unsupported', 404))
    client.sendMessageDraft.mockRejectedValueOnce(new TelegramApiError('unsupported', 404))
    client.sendMessage.mockRejectedValueOnce(new Error('connection lost after sending'))
    await drain()
    await vi.advanceTimersByTimeAsync(2400)
    start(p)
    chunk(p, 'new text', 2)
    await vi.advanceTimersByTimeAsync(30000)
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(p.finalHtml('final')).toBeUndefined()
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

  it('keeps code fences outside paragraph wrappers when persisting rich answers', () => {
    const { p } = setup()
    const html = p.finalHtml('Before\n\n```ts\nconst a = 1\n```\n\nAfter')
    expect(html).toContain('<pre>const a = 1')
    expect(html).not.toContain('<p><pre>')
    expect(html).toContain('After')
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

  it('coalesces tokens and refreshes the same native draft before its expiry', async () => {
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
    expect(client.sendRichMessageDraft.mock.calls.every(call => call[1] === p.draftId)).toBe(true)
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

  it('distinguishes tool preparation, execution, and failure without leaking arguments', async () => {
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
    const final = p.finalHtml('完成')
    expect(final).toContain('<details>')
    expect(final).toContain('❌ bash&lt;script&gt; · 2 秒')
    expect(final).not.toContain('secret')
  })

  it('falls back from rich to plain drafts to editing one tracked message', async () => {
    const { p, client, drain, track } = setup()
    client.sendRichMessageDraft.mockRejectedValueOnce(new TelegramApiError('unsupported', 404))
    client.sendMessageDraft.mockRejectedValueOnce(new TelegramApiError('unsupported', 400))
    await drain()
    await vi.advanceTimersByTimeAsync(1200)
    await vi.advanceTimersByTimeAsync(1200)
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith(42)
    start(p)
    chunk(p, '新增', 2)
    await vi.advanceTimersByTimeAsync(1200)
    expect(client.editMessageText).toHaveBeenCalledTimes(1)
    expect(client.sendMessage).toHaveBeenCalledTimes(1)
    expect(p.acceptsStop(p.draftId)).toBe(false)
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
    expect(client.sendMessageDraft).not.toHaveBeenCalled()
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
    expect(p.acceptsStop(p.draftId)).toBe(true)
    p.dispose()
    chunk(p, '迟到', 3)
    await vi.advanceTimersByTimeAsync(24000)
    expect(client.sendRichMessageDraft).toHaveBeenCalledTimes(1)
    expect(p.acceptsStop(p.draftId)).toBe(false)
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

  it('caps previews but leaves long final answers to the existing splitting path', async () => {
    const { p, client, drain } = setup()
    start(p)
    chunk(p, '中'.repeat(100000), 2)
    await drain()
    expect(String(client.sendRichMessageDraft.mock.calls.at(-1)?.[2]).length).toBeLessThan(20000)
    expect(p.finalHtml('中'.repeat(25000))).toBeUndefined()
  })
})
