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
