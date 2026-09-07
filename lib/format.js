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
export function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function run(text, open = '', close = '') {
    return { text, open, close };
}
/** Parse before splitting so links and formatting survive message boundaries. */
function inlineRuns(text, bold = false, allowLinks = true) {
    const result = [];
    const add = (value) => {
        const last = result.at(-1);
        if (last?.open === (bold ? '<b>' : ''))
            last.text += value;
        else
            result.push(run(value, bold ? '<b>' : '', bold ? '</b>' : ''));
    };
    for (let i = 0; i < text.length;) {
        const rest = text.slice(i);
        const code = /^(`+)([^\n]*?)\1(?!`)/.exec(rest);
        if (code && code[2] && !code[2].startsWith('`')) {
            result.push(run(code[2], '<code>', '</code>'));
            i += code[0].length;
            continue;
        }
        // Accept a backslash before the opening parenthesis (common model output),
        // and balanced parentheses within URLs, including escaped ones.
        const link = allowLinks ? /^\[([^\]\n]+)\]\\?\(/.exec(rest) : null;
        if (link) {
            let end = i + link[0].length;
            let depth = 1;
            let target = '';
            for (; end < text.length; end++) {
                let ch = text[end];
                if (ch === '\\' && /[()\\]/.test(text[end + 1] ?? ''))
                    ch = text[++end];
                if (ch === '(')
                    depth++;
                if (ch === ')' && --depth === 0)
                    break;
                if (ch === '\n')
                    break;
                target += ch;
            }
            const destination = /^(?:<([^<>]+)>|(\S+?))(?:\s+"[^"\n]*")?$/.exec(target);
            const url = destination?.[1] ?? destination?.[2];
            if (depth === 0 && url && /^(?:https?:\/\/|tg:\/\/|mailto:)[^\s<>]+$/i.test(url)) {
                for (const label of inlineRuns(link[1], bold, false)) {
                    // Telegram does not permit code entities nested inside links.
                    result.push(run(label.text, `<a href="${escapeHtml(url)}">${label.open === '<code>' ? '' : label.open}`, `${label.close === '</code>' ? '' : label.close}</a>`));
                }
                i = end + 1;
                continue;
            }
        }
        if (rest.startsWith('**')) {
            const end = text.indexOf('**', i + 2);
            if (end > i + 2 && !text.slice(i + 2, end).includes('\n')) {
                result.push(...inlineRuns(text.slice(i + 2, end), true, allowLinks));
                i = end + 2;
                continue;
            }
        }
        if (text[i] === '\\' && /[\\`*_[\]{}()#+.!|>~-]/.test(text[i + 1] ?? '')) {
            add(text[i + 1]);
            i += 2;
        }
        else {
            add(text[i]);
            i++;
        }
    }
    return result;
}
/** Split pipes outside inline code; escaped leading pipes are tolerated. */
function tableCells(line) {
    let value = line.trim().replace(/^\\\|/, '|');
    if (!value.includes('|'))
        return undefined;
    value = value.replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
    const cells = [];
    let cell = '';
    let fence = '';
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '\\' && i + 1 < value.length) {
            cell += value[i] + value[++i];
        }
        else if (value[i] === '`') {
            const ticks = /^`+/.exec(value.slice(i))[0];
            if (!fence)
                fence = ticks;
            else if (fence === ticks)
                fence = '';
            cell += ticks;
            i += ticks.length - 1;
        }
        else if (value[i] === '|' && !fence) {
            cells.push(cell.trim());
            cell = '';
        }
        else
            cell += value[i];
    }
    cells.push(cell.trim());
    return cells.length > 1 ? cells : undefined;
}
function cellText(text) {
    return inlineRuns(text).map(part => part.text).join('');
}
/** Terminal-style display widths for CJK and emoji in the preformatted table. */
function displayWidth(text) {
    let width = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (/\p{Mark}/u.test(ch) || cp === 0x200d)
            continue;
        width += cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
            || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
            || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f)
            || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
            || cp >= 0x1f300) ? 2 : 1;
    }
    return width;
}
function renderTable(rows) {
    const values = rows.map(row => row.map(cellText));
    const widths = values[0].map((_, col) => Math.min(24, Math.max(3, ...values.map(row => displayWidth(row[col] ?? '')))));
    const border = widths.map(width => '─'.repeat(width)).join('─┼─');
    const output = [];
    values.forEach((row, index) => {
        const wrapped = widths.map((width, col) => {
            const lines = [''];
            for (const ch of row[col] ?? '') {
                if (displayWidth(lines.at(-1) + ch) > width)
                    lines.push('');
                lines[lines.length - 1] += ch;
            }
            return lines;
        });
        for (let line = 0; line < Math.max(...wrapped.map(cell => cell.length)); line++) {
            output.push(widths.map((width, col) => {
                const value = wrapped[col][line] ?? '';
                return value + ' '.repeat(width - displayWidth(value));
            }).join(' │ ').trimEnd());
        }
        if (index === 0)
            output.push(border);
    });
    return output.join('\n');
}
function markdownRuns(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fenceLine = line.replace(/\\`/g, '`');
        const fence = /^[^\S\n]*(`{3,}|~{3,}|'{3,}|‘{3,}|’{3,})(?:[\w.+#-]+)?[^\S\n]*$/.exec(fenceLine);
        if (fence) {
            let end = i + 1;
            for (; end < lines.length; end++) {
                const close = lines[end].replace(/\\`/g, '`').trim();
                if (close.length >= fence[1].length && [...close].every(ch => ch === fence[1][0]))
                    break;
            }
            if (end < lines.length) {
                let code = lines.slice(i + 1, end).join('\n');
                if (line.includes('\\`')) {
                    // Some model replies escape an entire Markdown block for MarkdownV2.
                    // Decode only that compatibility form; ordinary code stays verbatim.
                    code = code.replace(/\\([\\`*_[\]{}()#+.!|>~=-])/g, '$1');
                }
                result.push(run(code, '<pre>', '</pre>'));
                i = end;
                if (i < lines.length - 1)
                    result.push(run('\n'));
                continue;
            }
            // An unfinished fence stays literal, including the following content.
            result.push(run(lines.slice(i).join('\n')));
            break;
        }
        const header = tableCells(line);
        const separator = tableCells(lines[i + 1] ?? '');
        if (header && separator?.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
            const rows = [header];
            i += 1;
            while (i + 1 < lines.length) {
                const cells = tableCells(lines[i + 1]);
                if (!cells || cells.length !== header.length)
                    break;
                rows.push(cells);
                i++;
            }
            result.push(run(renderTable(rows), '<pre>', '</pre>'));
        }
        else {
            const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
            result.push(...inlineRuns(heading?.[1] ?? line, !!heading));
        }
        if (i < lines.length - 1)
            result.push(run('\n'));
    }
    return result;
}
function renderRun(part) {
    return part.text ? part.open + escapeHtml(part.text) + part.close : '';
}
/** Convert headings, links, bold, code and tables to supported Telegram HTML. */
export function markdownToHtml(text) {
    return markdownRuns(text).map(renderRun).join('');
}
/** Split visible text, then reopen its formatting in each independent message. */
export function markdownToHtmlChunks(text, maxLength) {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
        throw new RangeError('maxLength must be a positive integer');
    }
    const chunks = [];
    let current = { html: '', plain: '' };
    const flush = () => {
        if (current.plain)
            chunks.push(current);
        current = { html: '', plain: '' };
    };
    for (const part of markdownRuns(text)) {
        for (const piece of splitMessage(part.text, maxLength)) {
            if (current.plain.length + piece.length > maxLength)
                flush();
            current.html += renderRun({ ...part, text: piece });
            current.plain += piece;
            if (current.plain.length >= maxLength)
                flush();
        }
    }
    flush();
    return chunks;
}
/**
 * Split text into chunks of at most `maxLength` characters, preferring the
 * last newline inside each window so prose breaks at line boundaries.
 * @param text - the text to split.
 * @param maxLength - the maximum chunk length (Telegram's 4096-char limit).
 * @returns one or more chunks covering the whole text.
 */
export function splitMessage(text, maxLength) {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
        throw new RangeError('maxLength must be a positive integer');
    }
    if (text.length <= maxLength)
        return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > maxLength) {
        const window = rest.slice(0, maxLength);
        const newline = window.lastIndexOf('\n');
        const ideographic = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'));
        const sentence = window.lastIndexOf('. ');
        const breakAt = Math.max(newline, ideographic, sentence);
        // A period-space break keeps its space; newline and ideographic breaks
        // cut right after the break character. Break at position zero or a full
        // window falls back to the hard limit.
        let cut = breakAt > 0 ? (breakAt === sentence ? breakAt + 2 : breakAt + 1) : maxLength;
        // Never split a UTF-16 surrogate pair: doing so corrupts emoji and other
        // supplementary Unicode characters in both resulting messages.
        if (cut < rest.length && /[\uD800-\uDBFF]/.test(rest[cut - 1])
            && /[\uDC00-\uDFFF]/.test(rest[cut])) {
            cut = cut === 1 ? 2 : cut - 1;
        }
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    // The loop leaves a non-empty remainder of at most maxLength characters.
    chunks.push(rest);
    return chunks;
}
