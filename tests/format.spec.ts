import { describe, expect, it } from 'vitest'
import { escapeHtml, markdownToHtml, markdownToHtmlChunks, splitMessage } from '../src/format.ts'

describe('escapeHtml', () => {
  it('escapes the five Telegram-special characters', () => {
    expect(escapeHtml('a & b < c > d " e \' f')).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f')
  })

  it('does not double-escape already escaped entities', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })
})

describe('markdownToHtml', () => {
  it('escapes plain text', () => {
    expect(markdownToHtml('a < b')).toBe('a &lt; b')
  })

  it('converts fenced code blocks to <pre>', () => {
    expect(markdownToHtml('before\n```ts\nconst x = 1 < 2\n```\nafter')).toBe(
      'before\n<pre>const x = 1 &lt; 2</pre>\nafter',
    )
  })

  it('strips the fence language tag and trailing newline', () => {
    expect(markdownToHtml('```js\ncode\n```')).toBe('<pre>code</pre>')
  })

  it('keeps unbalanced fences literal', () => {
    expect(markdownToHtml('```unclosed')).toBe('```unclosed')
  })

  it('converts inline code and bold', () => {
    expect(markdownToHtml('run `npm i` for **best** results')).toBe(
      'run <code>npm i</code> for <b>best</b> results',
    )
  })

  it('escapes content inside inline code', () => {
    expect(markdownToHtml('`a < b`')).toBe('<code>a &lt; b</code>')
  })

  it('does not interpret bold markers inside inline code', () => {
    expect(markdownToHtml('`**literal**`')).toBe('<code>**literal**</code>')
  })

  it('requires a bare closing fence line', () => {
    expect(markdownToHtml('```js\ncode\n```after')).toBe('```js\ncode\n```after')
  })
})

describe('markdownToHtmlChunks', () => {
  it('keeps every long fenced-code chunk independently valid', () => {
    const chunks = markdownToHtmlChunks(`before\n\`\`\`ts\n${'x'.repeat(24)}\n\`\`\`\nafter`, 10)
    expect(chunks.every(chunk => chunk.plain.length <= 10)).toBe(true)
    expect(chunks.every(chunk => (chunk.html.match(/<pre>/g)?.length ?? 0)
      === (chunk.html.match(/<\/pre>/g)?.length ?? 0))).toBe(true)
    expect(chunks.map(chunk => chunk.plain).join('')).toBe(`before\n${'x'.repeat(24)}\nafter`)
  })

  it('does not emit an empty tag-only message for an empty code fence', () => {
    expect(markdownToHtmlChunks('```\n```', 4096)).toEqual([])
  })
})

describe('splitMessage', () => {
  it('returns the whole text when it fits', () => {
    expect(splitMessage('short', 4096)).toEqual(['short'])
  })

  it('splits long text at the last newline inside the window', () => {
    const text = 'x'.repeat(100) + '\n' + 'y'.repeat(100)
    const chunks = splitMessage(text, 120)
    expect(chunks).toEqual(['x'.repeat(100) + '\n', 'y'.repeat(100)])
  })

  it('splits long text without breaks at the hard limit', () => {
    const chunks = splitMessage('a'.repeat(250), 100)
    expect(chunks).toEqual(['a'.repeat(100), 'a'.repeat(100), 'a'.repeat(50)])
  })

  it('prefers sentence punctuation before a hard cut', () => {
    const chunks = splitMessage('a'.repeat(90) + '。' + 'b'.repeat(90), 100)
    expect(chunks).toEqual(['a'.repeat(90) + '。', 'b'.repeat(90)])
  })

  it('covers the whole text exactly at the boundary', () => {
    expect(splitMessage('a'.repeat(100), 100)).toEqual(['a'.repeat(100)])
  })

  it('emits only full chunks when the text ends exactly at a chunk boundary', () => {
    expect(splitMessage('a'.repeat(400), 100)).toEqual(['a'.repeat(100), 'a'.repeat(100), 'a'.repeat(100), 'a'.repeat(100)])
  })

  it('cuts at the hard limit when the break character sits at position zero', () => {
    const chunks = splitMessage('\n' + 'a'.repeat(120), 100)
    expect(chunks).toEqual(['\n' + 'a'.repeat(99), 'a'.repeat(21)])
  })

  it('prefers a period-space break before a hard cut', () => {
    const chunks = splitMessage('a'.repeat(90) + '. ' + 'b'.repeat(90), 100)
    expect(chunks).toEqual(['a'.repeat(90) + '. ', 'b'.repeat(90)])
  })

  it('does not split an emoji surrogate pair', () => {
    const chunks = splitMessage(`a😀b`, 2)
    expect(chunks).toEqual(['a', '😀', 'b'])
    expect(chunks.join('')).toBe('a😀b')
  })

  it('rejects a non-positive limit instead of looping forever', () => {
    expect(() => splitMessage('text', 0)).toThrow('positive integer')
  })
})

describe('rich Markdown regressions', () => {
  it('renders headings, including existing bold', () => {
    expect(markdownToHtml('## 大标题\n### **重点** ###\n#tag')).toBe('<b>大标题</b>\n<b>重点</b>\n#tag')
  })

  it.each(["'''", '‘‘‘', '’’’', '~~~', '````'])('accepts %s fences and CRLF', fence => {
    expect(markdownToHtml(`  ${fence}text\r\n## **文字** <x>\r\n  ${fence}`)).toBe('<pre>## **文字** &lt;x&gt;</pre>')
  })

  it('keeps mismatched fences literal', () => {
    expect(markdownToHtml("'''\n文字\n```")).toBe('&#39;&#39;&#39;\n文字\n```')
  })

  it.each(['[文字](https://example.com/a_(b)?x=1&y=2)',
    String.raw`[文字]\(https://example.com/a_(b)?x=1&y=2)`,
    String.raw`[文字]\(https://example.com/a_\(b\)?x=1&y=2\)`])('renders links: %s', text => {
    expect(markdownToHtml(text)).toBe('<a href="https://example.com/a_(b)?x=1&amp;y=2">文字</a>')
  })

  it('supports formatted labels and titles, and escapes attributes', () => {
    expect(markdownToHtml('[**文字**](https://example.com "标题")')).toBe('<a href="https://example.com"><b>文字</b></a>')
    expect(markdownToHtml('[x](https://example.com/?q="x")')).toBe('<a href="https://example.com/?q=&quot;x&quot;">x</a>')
    expect(markdownToHtml('[x](javascript:alert(1))')).not.toContain('<a ')
    expect(markdownToHtml('`[x](https://example.com)`')).toBe('<code>[x](https://example.com)</code>')
  })

  it('renders the reported escaped table without Markdown markers', () => {
    const source = String.raw`\| 项目 | 内容 |
\|---|---|
\| 姓名 | 测试用户 |
\| 报考类型 | **直博生**（申请编号 123456789） |
\| 报考方向 | 信控（信息与控制） |
\| 综合成绩 | 177 |
\| 排名 | 3 |
\| 考核等级 | **优秀营员** |`
    const html = markdownToHtml(source)
    expect(html).toMatch(/^<pre>项目/)
    expect(html).toContain('姓名     │ 测试用户')
    expect(html).toContain('直博生')
    expect(html).toContain('优秀营员')
    expect(html).not.toMatch(/\*\*|\\\||\|---/)
    expect(html).toContain('─┼─')
    expect(html).toMatch(/<\/pre>$/)
  })

  it('handles multiple columns and literal pipes', () => {
    expect(markdownToHtml('| A | B | C |\n|:---|:---:|---:|\n| x\\|y | `a|b` | **c** |')).toBe(
      '<pre>A   │ B   │ C\n────┼─────┼────\nx|y │ a|b │ c</pre>',
    )
    expect(markdownToHtml('a | b\ntext | more')).toBe('a | b\ntext | more')
    expect(markdownToHtml('```\n| A | B |\n|---|---|\n```')).toBe('<pre>| A | B |\n|---|---|</pre>')
  })

  it('preserves long formatting across message boundaries', () => {
    const source = '## **大标题**\n[**' + '链接😀'.repeat(20) + '**](https://example.com)\n'
      + "'''\n" + '<code>&'.repeat(20) + "\n'''\n| A | B |\n|---|---|\n| 很长的表格内容 | 1234567890 |"
    const chunks = markdownToHtmlChunks(source, 12)
    for (const chunk of chunks) {
      expect(chunk.plain.length).toBeLessThanOrEqual(12)
      const stack: string[] = []
      for (const tag of chunk.html.matchAll(/<(\/?)(b|a|pre|code)(?:\s[^>]*)?>/g)) {
        if (tag[1]) expect(stack.pop()).toBe(tag[2])
        else stack.push(tag[2])
      }
      expect(stack).toEqual([])
    }
    expect(chunks.map(chunk => chunk.plain).join('')).toBe(markdownToHtmlChunks(source, 4096).map(chunk => chunk.plain).join(''))
    expect(chunks.filter(chunk => chunk.html.includes('<a ')).length).toBeGreaterThan(1)
    expect(() => markdownToHtmlChunks('', 0)).toThrow('positive integer')
  })
})

describe('escaped code fences in numbered replies', () => {
  it('recognizes backslash-escaped backticks with NBSP indentation', () => {
    const source = '2\\. Windows **fake-ip 模式**：\n\u00a0\u00a0 \\`\\`\\`\n'
      + '   speit.example.com → 198.18.0.16\n   www\\.example.com → 198.18.0.19\n'
      + '\u00a0\u00a0 \\`\\`\\`\n3\\. DSH 的 web\\_fetch...'
    expect(markdownToHtml(source)).toBe('2. Windows <b>fake-ip 模式</b>：\n'
      + '<pre>   speit.example.com → 198.18.0.16\n   www.example.com → 198.18.0.19</pre>\n3. DSH 的 web_fetch...')
    expect(markdownToHtmlChunks(source, 24).map(chunk => chunk.plain).join('')).not.toMatch(/\\[.`_]/)
  })

  it('preserves backslashes in normal code fences', () => {
    expect(markdownToHtml('    ```\nwww\\.example.com\n    ```')).toBe('<pre>www\\.example.com</pre>')
  })
})

describe('phone screenshot formatting regressions', () => {
  it('renders emphasis, combined emphasis and strike without stray markers', () => {
    expect(markdownToHtml('*斜体* ***粗斜体*** ~~删除~~ _斜体_ __粗体__')).toBe(
      '<i>斜体</i> <b><i>粗斜体</i></b> <s>删除</s> <i>斜体</i> <b>粗体</b>',
    )
    expect(markdownToHtml('**粗体里 `代码` 和 *斜体***')).toBe(
      '<b>粗体里 </b><code>代码</code><b> 和 </b><b><i>斜体</i></b>',
    )
  })

  it('preserves escapes, identifiers and code contents', () => {
    expect(markdownToHtml(String.raw`\*不是斜体\* foo_bar_baz \_普通\_`)).toBe('*不是斜体* foo_bar_baz _普通_')
    expect(markdownToHtml('`*x* ~~y~~`')).toBe('<code>*x* ~~y~~</code>')
    expect(markdownToHtml('**a `**` b**')).toBe('<b>a </b><code>**</code><b> b</b>')
  })

  it('turns images into descriptive links without a dangling exclamation mark', () => {
    expect(markdownToHtml('![示例](https://example.com/image.png)')).toBe('<a href="https://example.com/image.png">图片：示例</a>')
  })

  it('renders continuous quotes, alerts and flattened nested quotes', () => {
    expect(markdownToHtml('> [!WARNING]\n> **小心**\n>> 第二行')).toBe(
      '<blockquote><b>警告</b>\n<b>小心</b>\n第二行</blockquote>',
    )
    expect(markdownToHtml('嵌套： > - 文字')).toBe('嵌套： &gt; - 文字')
  })

  it('renders dividers and indented code while protecting literal HTML', () => {
    expect(markdownToHtml('上方\n\n---\n\n下方')).toBe('上方\n\n────────\n\n下方')
    expect(markdownToHtml('    <b>代码</b>\n    *原样*\n\n正文')).toBe('<pre>&lt;b&gt;代码&lt;/b&gt;\n*原样*</pre>\n\n正文')
    expect(markdownToHtml('<b>HTML</b>')).toBe('&lt;b&gt;HTML&lt;/b&gt;')
  })

  it('keeps quotes and styles balanced when split', () => {
    const source = '> [!NOTE]\n> ***长内容😀长内容***\n> ~~删除内容~~'
    const chunks = markdownToHtmlChunks(source, 6)
    expect(chunks.map(chunk => chunk.plain).join('')).toBe('提示\n长内容😀长内容\n删除内容')
    for (const chunk of chunks) {
      expect(chunk.plain.length).toBeLessThanOrEqual(6)
      const stack: string[] = []
      for (const tag of chunk.html.matchAll(/<(\/?)(blockquote|b|i|s)>/g)) {
        if (tag[1]) expect(stack.pop()).toBe(tag[2])
        else stack.push(tag[2])
      }
      expect(stack).toEqual([])
    }
  })
})
