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
  it('renders a tool with no input or output as a non-expandable summary', () => {
    const t = new TelegramTranscript()
    t.event({ type: 'tool/call', data: { name: 'empty_tool', callId: 'a', arguments: '', step: 1, turn: 1 } } as SessionEvent)
    result(t, 'a', '')
    const text = t.render('完成')
    expect(text).toContain('工具调用 · empty_tool · a')
    expect(text.match(/<details>/g)).toHaveLength(1)
    expect(text).not.toMatch(/<\/summary>\s*<\/details>/)
  })

  it('puts messages at depth one and reasoning/paired tools at depth two', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, ['**检查中**', '\n\n| A | B |\n|---|---|\n| 1 | 2 |'], '**检查计划**\n\n- 检查文件')
    call(t, 'bash', { description: '运行测试', command: 'pnpm test' })
    result(t, 'bash', '**全部通过**')
    assistant(t, 2, ['完成'], '**整理结果**\n\n$x^2$')
    const text = t.render('完成')
    expect(text).toMatch(/^<details><summary>1 次工具调用 · 1 条消息<\/summary>/)
    expect(text).toContain('<summary>思考 · 检查计划</summary>\n\n**检查计划**')
    expect(text).toContain('</details>\n\n**检查中**')
    expect(text).toContain('| A | B |')
    expect(text).toContain('<summary>Bash · 运行测试</summary>')
    expect(text).toContain('```bash\npnpm test\n```')
    expect(text).toContain('**输出**\n\n**全部通过**')
    expect(text).toContain('$x^2$')
    expect(text).not.toContain('完成')
    expect(text.match(/<details>/g)).toHaveLength(4)
    expect(text.match(/<\/details>/g)).toHaveLength(4)
  })

  it('counts messages, not blocks or reasoning, and excludes every message in the final step', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, [], '思考')
    assistant(t, 2, ['第一段', '第二段'])
    assistant(t, 3, ['同一步的消息'])
    assistant(t, 3, ['最后答案'])
    expect(t.render('最后答案')).toMatch(/^<details><summary>1 条消息<\/summary>/)
    const reasoning = new TelegramTranscript()
    assistant(reasoning, 1, ['答案'], '仅有思考')
    expect(reasoning.render('答案')).toMatch(/^<details><summary>已思考<\/summary>/)
  })

  it('counts started calls and groups out-of-order results with their own call', () => {
    const t = new TelegramTranscript()
    call(t, 'read', { file_path: 'a.ts' }, 'a')
    call(t, 'read', { file_path: 'b.ts' }, 'b')
    call(t, 'subagent_research', { prompt: '研究' })
    result(t, 'b', 'B 结果')
    result(t, 'a', 'A 结果')
    const text = t.render('完成')
    expect(text).toContain('<summary>2 次工具调用 · 1 个 subagent</summary>')
    expect(text.indexOf('A 结果')).toBeLessThan(text.indexOf('读取 · b.ts'))
    expect(text).toContain('B 结果')
  })

  it.each([
    ['read', { file_path: '/work/src/a.ts' }, '读取 · src/a.ts'],
    ['bash', { command: 'ls\npwd', description: '检查目录' }, 'Bash · 检查目录'],
    ['glob', { pattern: '*.ts' }, 'Glob · *.ts'],
    ['web_search', { queries: ['第一项\n换行', '第二项'] }, '网页搜索 · 第一项, 第二项'],
    ['run_code', { description: '处理数据', code: 'return 1' }, '代码 · 处理数据'],
    ['custom', { value: '参数' }, '工具调用 · custom · 参数'],
    ['todo_write', { todos: [{ content: '完成项', status: 'completed' }, { content: '运行项', status: 'in_progress' }] }, '更新任务清单 · 1/2 已完成 · 运行项'],
  ])('matches native row title and argument summary for %s', (name, args, title) => {
    const t = new TelegramTranscript('/work', '/home/user')
    call(t, String(name), args)
    expect(t.render('完成')).toContain(`<summary>${title}</summary>`)
  })

  it('replaces a failed tool summary with the error first line', () => {
    const t = new TelegramTranscript()
    call(t, 'read', { file_path: 'a.ts' })
    result(t, 'read', '文件不存在\n**请检查路径**', true)
    expect(t.render('完成')).toContain('<summary>读取 · 文件不存在</summary>')
    expect(t.render('完成')).toContain('**请检查路径**')
  })

  it('uses applied diff metadata for native change counts and a rich diff body', () => {
    const t = new TelegramTranscript('/work')
    call(t, 'edit', { file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })
    t.event({ type: 'tool/result', data: { meta: { diffs: [{ path: 'a.ts', oldText: 'a\n', newText: 'b\nc\n' }] },
      message: { content: [{ type: 'tool-result', toolCallId: 'edit', content: [{ type: 'text', text: 'updated' }] }] },
    } } as SessionEvent)
    expect(t.render('完成')).toContain('<summary>编辑 · a.ts +2 -1</summary>')
    expect(t.render('完成')).toContain('```diff\n--- a.ts\n+++ a.ts\n-a\n+b\n+c\n```')
  })

  it('does not count surface replacements as additional transcript messages', () => {
    const t = new TelegramTranscript()
    assistant(t, 1, ['原消息'])
    t.event({ type: 'assistant/message', surfaceOp: 'replace', data: { step: 1,
      message: { content: [{ type: 'text', text: '内部压缩替换' }] },
    } } as unknown as SessionEvent)
    assistant(t, 2, ['最终答案'])
    expect(t.render('最终答案')).toContain('<summary>1 条消息</summary>')
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
