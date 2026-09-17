import { describe, expect, it } from 'vitest'
import { escapeHtml, markdownToRichHtml, markdownToHtml, markdownToHtmlChunks, splitMessage } from '../src/format.ts'

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
    expect(html).toMatch(/^<b>项目<\/b>：姓名/)
    expect(html).toContain('<b>内容</b>：测试用户')
    expect(html).toContain('直博生')
    expect(html).toContain('优秀营员')
    expect(html).not.toMatch(/\*\*|\\\||\|---/)
    expect(html).not.toContain('─┼─')
    expect(html).toContain('<b>优秀营员</b>')
  })

  it('handles multiple columns and literal pipes', () => {
    expect(markdownToHtml('| A | B | C |\n|:---|:---:|---:|\n| x\\|y | `a|b` | **c** |')).toBe(
      '<b>A</b>：x|y\n<b>B</b>：<code>a|b</code>\n<b>C</b>：<b>c</b>',
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

describe('native Rich HTML', () => {
  it('renders the screenshot structure with native blocks and no blank-line padding', () => {
    const html = markdownToRichHtml('# 导航行业\n\n\n简介 **重点**\n\n---\n\n## 系统\n\n'
      + '| 系统 | 进展 | 精度 |\n|---|---|---|\n| **GPS** | 很长的中文说明无需插入换行 | `L1C` |\n\n'
      + '> [!NOTE]\n> 提示内容\n\n- 第一项\n- 第二项\n\n3. 第三项\n4. 第四项')
    expect(html).toBe('<h1>导航行业</h1><p>简介 <b>重点</b></p><hr/><h2>系统</h2>'
      + '<table><tr><th>系统</th><th>进展</th><th>精度</th></tr>'
      + '<tr><td><b>GPS</b></td><td>很长的中文说明无需插入换行</td><td><code>L1C</code></td></tr></table>'
      + '<blockquote><b>提示</b><br>提示内容</blockquote>'
      + '<ul><li>第一项</li><li>第二项</li></ul><ol><li value="3">第三项</li><li value="4">第四项</li></ol>')
    expect(html).not.toMatch(/<p><(?:table|blockquote)|─|<br><br>/)
  })

  it('keeps code literal, including tables, blank lines and unfinished streaming fences', () => {
    const code = '| A | B |\n|---|---|\n\n---\n<b>literal</b>'
    expect(markdownToRichHtml('```html\n' + code)).toBe(
      '<pre><code class="language-html">' + escapeHtml(code) + '</code></pre>')
    expect(markdownToRichHtml('```\n' + code + '\n```\n\nAfter')).toBe(
      '<pre>' + escapeHtml(code) + '</pre><p>After</p>')
    expect(markdownToRichHtml('    <b>literal</b>')).toBe('<pre>&lt;b&gt;literal&lt;/b&gt;</pre>')
  })

  it('escapes raw HTML, keeps image links, and preserves inline table formatting', () => {
    const html = markdownToRichHtml('<hr/>\n\n![image](https://example.com/x.png)\n\n'
      + '| A | B |\n|---|---|\n| x\\|y | [**link**](https://example.com) and `a|b` |')
    expect(html).toContain('<p>&lt;hr/&gt;</p>')
    expect(html).toContain('<a href="https://example.com/x.png">图片：image</a>')
    expect(html).toContain('<td>x|y</td>')
    expect(html).toContain('<a href="https://example.com"><b>link</b></a> and <code>a|b</code>')
    expect(html).not.toContain('<img')
  })

  it('keeps incomplete table rows visible and falls back for tables beyond the API column limit', () => {
    expect(markdownToRichHtml('| A | B |\n|---|---|\n| partial')).toContain('</table><p>| partial</p>')
    const row = Array.from({ length: 21 }, (_, i) => `列${i}`).join(' | ')
    const separator = Array(21).fill('---').join(' | ')
    const html = markdownToRichHtml(row + '\n' + separator + '\n' + row)
    expect(html).not.toContain('<table>')
    expect(html).toContain('<b>列20</b>：列20')
  })

  it('keeps list continuations together and preserves deliberate numbering', () => {
    expect(markdownToRichHtml('3. 第三项\n   补充说明\n\n7. 第七项\n\n正文')).toBe(
      '<ol><li value="3">第三项<br>补充说明</li><li value="7">第七项</li></ol><p>正文</p>')
  })
})

it('preserves nested lists inside their parent item', () => {
  expect(markdownToRichHtml('1. 方向\n   - 电网\n   - 金融\n2. 建议')).toBe(
    '<ol><li value="1">方向<ul><li>电网</li><li>金融</li></ul></li><li value="2">建议</li></ol>')
})
