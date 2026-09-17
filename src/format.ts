/**
 * Telegram message formatting helpers: HTML escaping, a conservative
 * Markdown→HTML subset, and the 4096-character split Telegram enforces.
 * @module telegram/format
 */

/**
 * Escape the five characters Telegram's HTML parse mode treats specially.
 * @param text - the raw text to escape.
 * @returns the HTML-escaped text.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A visible text run with trusted, generated HTML wrappers. */
interface Run {
  text: string
  open: string
  close: string
}

function run(text: string, open = '', close = ''): Run {
  return { text, open, close }
}

/** Parse before splitting so links and formatting survive message boundaries. */
function inlineRuns(text: string, bold = false, allowLinks = true): Run[] {
  const result: Run[] = []
  const add = (value: string): void => {
    const last = result.at(-1)
    if (last?.open === (bold ? '<b>' : '')) last.text += value
    else result.push(run(value, bold ? '<b>' : '', bold ? '</b>' : ''))
  }
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i)
    const code = /^(`+)([^\n]*?)\1(?!`)/.exec(rest)
    if (code && code[2] && !code[2].startsWith('`')) {
      result.push(run(code[2], '<code>', '</code>'))
      i += code[0].length
      continue
    }
    // Accept a backslash before the opening parenthesis (common model output),
    // and balanced parentheses within URLs, including escaped ones.
    const link = allowLinks ? /^(!?)\[([^\]\n]+)\]\\?\(/.exec(rest) : null
    if (link) {
      let end = i + link[0].length
      let depth = 1
      let target = ''
      for (; end < text.length; end++) {
        let ch = text[end]
        if (ch === '\\' && /[()\\]/.test(text[end + 1] ?? '')) ch = text[++end]
        if (ch === '(') depth++
        if (ch === ')' && --depth === 0) break
        if (ch === '\n') break
        target += ch
      }
      const destination = /^(?:<([^<>]+)>|(\S+?))(?:\s+"[^"\n]*")?$/.exec(target)
      const url = destination?.[1] ?? destination?.[2]
      if (depth === 0 && url && /^(?:https?:\/\/|tg:\/\/|mailto:)[^\s<>]+$/i.test(url)) {
        for (const label of inlineRuns(link[1] ? `图片：${link[2]}` : link[2], bold, false)) {
          // Telegram does not permit code entities nested inside links.
          result.push(run(label.text, `<a href="${escapeHtml(url)}">${label.open === '<code>' ? '' : label.open}`,
            `${label.close === '</code>' ? '' : label.close}</a>`))
        }
        i = end + 1
        continue
      }
    }
    // A conservative, balanced emphasis subset; never style inside code.
    const marker = /^(\*{1,3}|_{1,3}|~~)/.exec(rest)?.[0]
    if (marker && !/\s/.test(text[i + marker.length] ?? ' ')
      && !(marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) {
      let end = i + marker.length
      for (; end < text.length; end++) {
        if (text[end] === '\\') { end++; continue }
        if (text[end] === '`') {
          const codeSpan = /^(`+)([^\n]*?)\1(?!`)/.exec(text.slice(end))
          if (codeSpan) { end += codeSpan[0].length - 1; continue }
        }
        if (marker.length === 2 && marker !== '~~' && text.startsWith(marker + marker[0], end)) end++
        if (text.startsWith(marker, end) && !/\s/.test(text[end - 1])
          && !(marker[0] === '_' && /[\p{L}\p{N}]/u.test(text[end + marker.length] ?? ''))) break
      }
      if (end < text.length && !text.slice(i, end).includes('\n')) {
        const tags = marker === '~~' ? ['s'] : marker.length === 3 ? ['b', 'i']
          : marker.length === 2 ? ['b'] : ['i']
        for (const part of inlineRuns(text.slice(i + marker.length, end), bold, allowLinks)) {
          const wrappers = tags.filter(tag => !part.open.includes(`<${tag}>`))
          result.push(part.open === '<code>' ? part : run(part.text,
            wrappers.map(tag => `<${tag}>`).join('') + part.open,
            part.close + wrappers.slice().reverse().map(tag => `</${tag}>`).join('')))
        }
        i = end + marker.length
        continue
      }
    }
    if (text[i] === '\\' && /[\\`*_[\]{}()#+.!|>~-]/.test(text[i + 1] ?? '')) {
      add(text[i + 1]); i += 2
    } else {
      add(text[i]); i++
    }
  }
  return result
}

/** Split pipes outside inline code; escaped leading pipes are tolerated. */
function tableCells(line: string): string[] | undefined {
  let value = line.trim().replace(/^\\\|/, '|')
  if (!value.includes('|')) return undefined
  value = value.replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  const cells: string[] = []
  let cell = ''
  let fence = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) {
      cell += value[i] + value[++i]
    } else if (value[i] === '`') {
      const ticks = /^`+/.exec(value.slice(i))![0]
      if (!fence) fence = ticks
      else if (fence === ticks) fence = ''
      cell += ticks
      i += ticks.length - 1
    } else if (value[i] === '|' && !fence) {
      cells.push(cell.trim()); cell = ''
    } else cell += value[i]
  }
  cells.push(cell.trim())
  return cells.length > 1 ? cells : undefined
}

/** Ordinary command/question messages: preserve each cell without fixed-width grids. */
function tableRuns(rows: string[][]): Run[] {
  const result: Run[] = []
  for (const [index, row] of rows.slice(1).entries()) {
    if (index) result.push(run('\n\n'))
    row.forEach((cell, col) => {
      if (col) result.push(run('\n'))
      result.push(...inlineRuns(rows[0][col], true), run('：'), ...inlineRuns(cell))
    })
  }
  return result.length ? result : inlineRuns(rows[0].join(' · '), true)
}

function markdownRuns(text: string): Run[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const result: Run[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceLine = line.replace(/\\`/g, '`')
    const fence = /^[^\S\n]*(`{3,}|~{3,}|'{3,}|‘{3,}|’{3,})(?:[\w.+#-]+)?[^\S\n]*$/.exec(fenceLine)
    if (fence) {
      let end = i + 1
      for (; end < lines.length; end++) {
        const close = lines[end].replace(/\\`/g, '`').trim()
        if (close.length >= fence[1].length && [...close].every(ch => ch === fence[1][0])) break
      }
      if (end < lines.length) {
        let code = lines.slice(i + 1, end).join('\n')
        if (line.includes('\\`')) {
          // Some model replies escape an entire Markdown block for MarkdownV2.
          // Decode only that compatibility form; ordinary code stays verbatim.
          code = code.replace(/\\([\\`*_[\]{}()#+.!|>~=-])/g, '$1')
        }
        result.push(run(code, '<pre>', '</pre>'))
        i = end
        if (i < lines.length - 1) result.push(run('\n'))
        continue
      }
      // An unfinished fence stays literal, including the following content.
      result.push(run(lines.slice(i).join('\n')))
      break
    }
    // Flatten nested quotes: Telegram text messages cannot nest blockquotes.
    if (/^ {0,3}>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^(?: {0,3}>[ \t]?)+/, ''))
        i++
      }
      i--
      const alerts: Record<string, string> = {
        NOTE: '提示', TIP: '建议', IMPORTANT: '重要', WARNING: '警告', CAUTION: '注意',
      }
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(quoted[0])
      if (alert) quoted[0] = `**${alerts[alert[1]]}**`
      for (const part of markdownRuns(quoted.join('\n'))) {
        result.push(run(part.text, '<blockquote>' + part.open, part.close + '</blockquote>'))
      }
      if (i < lines.length - 1) result.push(run('\n'))
      continue
    }
    if (/^(?: {4}|\t)/.test(line) && (i === 0 || !lines[i - 1].trim())) {
      const code: string[] = []
      let end = i
      while (end < lines.length && (/^(?: {4}|\t)/.test(lines[end]) || !lines[end].trim())) {
        code.push(lines[end].replace(/^(?: {4}|\t)/, ''))
        end++
      }
      while (code.length && !code.at(-1)!.trim()) { code.pop(); end-- }
      result.push(run(code.join('\n'), '<pre>', '</pre>'))
      i = end - 1
      if (i < lines.length - 1) result.push(run('\n'))
      continue
    }
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      result.push(run('────────'))
      if (i < lines.length - 1) result.push(run('\n'))
      continue
    }
    const header = tableCells(line)
    const separator = tableCells(lines[i + 1] ?? '')
    if (header && separator?.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows = [header]
      i += 1
      while (i + 1 < lines.length) {
        const cells = tableCells(lines[i + 1])
        if (!cells || cells.length !== header.length) break
        rows.push(cells); i++
      }
      result.push(...tableRuns(rows))
    } else {
      const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
      result.push(...inlineRuns(heading?.[1] ?? line, !!heading))
    }
    if (i < lines.length - 1) result.push(run('\n'))
  }
  return result
}

function renderRun(part: Run): string {
  return part.text ? part.open + escapeHtml(part.text) + part.close : ''
}

/** Convert the supported Markdown subset to independently splittable Telegram HTML. */
export function markdownToHtml(text: string): string {
  return markdownRuns(text).map(renderRun).join('').replace(/<\/blockquote><blockquote>/g, '')
}

/** One independently valid Telegram message in HTML and plain-text forms. */
export interface TelegramMessageChunk {
  readonly html: string
  readonly plain: string
}

/** Split visible text, then reopen its formatting in each independent message. */
export function markdownToHtmlChunks(text: string, maxLength: number): TelegramMessageChunk[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer')
  }
  const chunks: TelegramMessageChunk[] = []
  let current = { html: '', plain: '' }
  const flush = (): void => {
    if (current.plain) {
      current.html = current.html.replace(/<\/blockquote><blockquote>/g, '')
      chunks.push(current)
    }
    current = { html: '', plain: '' }
  }
  for (const part of markdownRuns(text)) {
    for (const piece of splitMessage(part.text, maxLength)) {
      if (current.plain.length + piece.length > maxLength) flush()
      current.html += renderRun({ ...part, text: piece })
      current.plain += piece
      if (current.plain.length >= maxLength) flush()
    }
  }
  flush()
  return chunks
}

/**
 * Split text into chunks of at most `maxLength` characters, preferring the
 * last newline inside each window so prose breaks at line boundaries.
 * @param text - the text to split.
 * @param maxLength - the maximum chunk length (Telegram's 4096-char limit).
 * @returns one or more chunks covering the whole text.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new RangeError('maxLength must be a positive integer')
  }
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength)
    const newline = window.lastIndexOf('\n')
    const ideographic = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'))
    const sentence = window.lastIndexOf('. ')
    const breakAt = Math.max(newline, ideographic, sentence)
    // A period-space break keeps its space; newline and ideographic breaks
    // cut right after the break character. Break at position zero or a full
    // window falls back to the hard limit.
    let cut = breakAt > 0 ? (breakAt === sentence ? breakAt + 2 : breakAt + 1) : maxLength
    // Never split a UTF-16 surrogate pair: doing so corrupts emoji and other
    // supplementary Unicode characters in both resulting messages.
    if (cut < rest.length && /[\uD800-\uDBFF]/.test(rest[cut - 1] as string)
      && /[\uDC00-\uDFFF]/.test(rest[cut] as string)) {
      cut = cut === 1 ? 2 : cut - 1
    }
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  // The loop leaves a non-empty remainder of at most maxLength characters.
  chunks.push(rest)
  return chunks
}
