import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TelegramTranscript, richBody } from '../src/transcript.ts'
import { richExamples } from './fixtures/rich-markdown.ts'

function assistant(t: TelegramTranscript, step: number, texts: string[], thinking?: string) {
  t.event({ type: 'assistant/message', surfaceOp: 'append', data: { step, message: { content: [
    ...(thinking ? [{ type: 'reasoning', text: thinking }] : []), ...texts.map(text => ({ type: 'text', text })),
  ] } } } as SessionEvent)
}
function call(t: TelegramTranscript, name: string, args: unknown, id = name) {
  t.event({ type: 'tool/call', data: { name, callId: id, arguments: JSON.stringify(args), step: 1, turn: 1 } } as SessionEvent)
}
function result(t: TelegramTranscript, id: string, text: string, isError = false) {
  t.event({ type: 'tool/result', surfaceOp: 'append', data: { message: { content: [
    { type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }], isError },
  ] } } } as SessionEvent)
}

describe('DSH process disclosure projection', () => {
  it('shows only numbered intermediate messages with rich formatting and call counts', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, ['**检查中**', '\n\n| A | B |\n|---|---|\n| 1 | 2 |'], '私有思考')
    call(t, 'bash', { description: '运行测试', command: 'pnpm test' })
    result(t, 'bash', '工具结果')
    assistant(t, 2, ['第二条消息'])
    assistant(t, 3, ['最终正文'], '最终思考')
    const text = t.render('最终正文')
    expect(text).toContain('<summary>1 次工具调用 · 2 条消息</summary>')
    expect(text).toContain('**消息 1**\n\n**检查中**\n\n| A | B |')
    expect(text).toContain('\n\n---\n\n**消息 2**\n\n第二条消息')
    for (const hidden of ['私有思考', '最终思考', '运行测试', 'pnpm test', '工具结果', '最终正文']) {
      expect(text).not.toContain(hidden)
    }
    expect(text.match(/<details>/g)).toHaveLength(1)
  })

  it('counts messages rather than blocks and excludes the final step', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, [], '思考')
    assistant(t, 2, ['第一段', '第二段'])
    assistant(t, 3, ['同一步的消息'])
    assistant(t, 3, ['最后答案'])
    expect(t.render('最后答案')).toContain('<summary>0 次工具调用 · 1 条消息</summary>')
    expect(t.render('最后答案')).toContain('第一段第二段')
    expect(t.render('最后答案')).not.toContain('同一步的消息')
    const reasoning = new TelegramTranscript()
    assistant(reasoning, 1, ['答案'], '仅有思考')
    expect(reasoning.render('答案')).toBe('')
  })

  it('counts all started calls without rendering tool details or counting results again', () => {
    const t = new TelegramTranscript()
    call(t, 'read', { file_path: 'a.ts' }, 'a')
    call(t, 'read', { file_path: 'b.ts' }, 'b')
    call(t, 'subagent_research', { prompt: '研究' })
    result(t, 'b', 'B 结果')
    result(t, 'a', 'A 结果', true)
    expect(t.render('完成')).toBe('<details><summary>3 次工具调用 · 0 条消息</summary>\n\n暂无中间消息。\n\n</details>')
  })

  it('closes unfinished message syntax before the next message and outer boundary', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, ['```ts\nconst x = 1'])
    assistant(t, 2, ['<details><summary>附注</summary>\n\n内容'])
    assistant(t, 3, ['最终正文'])
    const text = t.render('最终正文')
    expect(text).toContain('const x = 1\n```\n\n---\n\n**消息 2**')
    expect(text).toContain('内容\n\n</details>\n\n</details>')
  })

  it('does not count surface replacements as additional transcript messages', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, ['原消息'])
    t.event({ type: 'assistant/message', surfaceOp: 'replace', data: { step: 1,
      message: { content: [{ type: 'text', text: '内部压缩替换' }] },
    } } as unknown as SessionEvent)
    assistant(t, 2, ['最终答案'])
    expect(t.render('最终答案')).toContain('<summary>0 次工具调用 · 1 条消息</summary>')
    expect(t.render('最终答案')).not.toContain('内部压缩替换')
  })

  it.each(richExamples)('keeps native rich formatting in intermediate messages: %s', (_name, source) => {
    const t = new TelegramTranscript()
    assistant(t, 1, [source])
    assistant(t, 2, ['最终'])
    expect(t.render('最终')).toContain(source)
  })

  it('isolates broken fences and unmatched details without escaping valid Markdown', () => {
    expect(richBody('```ts\nconst x = 1')).toBe('```ts\nconst x = 1\n```')
    expect(richBody('**保留**\n</details>')).toBe('**保留**\n&lt;/details&gt;')
    expect(richBody('```html\n</details>\n```')).toBe('```html\n</details>\n```')
    expect(richBody('<details><summary>内部</summary>\n\n**内容**\n\n</details>'))
      .toBe('<details><summary>内部</summary>\n\n**内容**\n\n</details>')
  })
})
