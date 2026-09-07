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
/**
 * Convert inline Markdown (inline code, **bold**) to Telegram HTML.
 * Fenced blocks are handled by {@link markdownToHtml}; this function only
 * runs on non-fence segments.
 */
function inlineToHtml(text) {
    return text.split(/(`[^`\n]+`)/g).map((part) => {
        if (part.startsWith('`') && part.endsWith('`')) {
            return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        }
        return escapeHtml(part).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }).join('');
}
const OPEN_FENCE_LINE = /^```(?:[\w-]+)?[ \t]*(?:\n|$)$/;
const CLOSE_FENCE_LINE = /^```[ \t]*(?:\n|$)$/;
/** Split balanced line-oriented fences into plain and code segments. */
function markdownSegments(text) {
    const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(line => line !== '') ?? [];
    const segments = [];
    let kind = 'plain';
    let buffer = '';
    for (const line of lines) {
        const isFence = kind === 'plain' ? OPEN_FENCE_LINE.test(line) : CLOSE_FENCE_LINE.test(line);
        if (!isFence) {
            buffer += line;
            continue;
        }
        if (kind === 'plain') {
            if (buffer !== '')
                segments.push({ kind, text: buffer });
            buffer = '';
            kind = 'code';
            continue;
        }
        const code = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
        segments.push({ kind, text: code });
        buffer = line.endsWith('\n') ? '\n' : '';
        kind = 'plain';
    }
    if (kind === 'code')
        return [{ kind: 'plain', text }];
    if (buffer !== '')
        segments.push({ kind, text: buffer });
    return segments;
}
/**
 * Convert a conservative Markdown subset to Telegram HTML: fenced code blocks
 * to `<pre>`, inline code to `<code>`, `**bold**` to `<b>`; everything else is
 * HTML-escaped. Unbalanced fences stay literal because a dangling `<pre>`
 * would make Telegram reject the message.
 * @param text - the markdown text to convert.
 * @returns Telegram-HTML text.
 */
export function markdownToHtml(text) {
    return markdownSegments(text).map(segment => segment.kind === 'code'
        ? `<pre>${escapeHtml(segment.text)}</pre>`
        : inlineToHtml(segment.text)).join('');
}
/**
 * Format and split Markdown without leaving a fenced code tag open across
 * Telegram messages.
 * @param text - markdown text to format.
 * @param maxLength - maximum visible characters per Telegram message.
 * @returns independently valid HTML chunks and their plain-text fallbacks.
 */
export function markdownToHtmlChunks(text, maxLength) {
    const chunks = [];
    let current = { html: '', plain: '' };
    const flush = () => {
        if (current.plain === '' && current.html === '')
            return;
        chunks.push(current);
        current = { html: '', plain: '' };
    };
    for (const segment of markdownSegments(text)) {
        // A tag-only `<pre></pre>` has no message text and Telegram rejects it.
        if (segment.text === '')
            continue;
        for (const piece of splitMessage(segment.text, maxLength)) {
            if (current.plain.length + piece.length > maxLength)
                flush();
            const html = segment.kind === 'code'
                ? `<pre>${escapeHtml(piece)}</pre>`
                : inlineToHtml(piece);
            current = { html: current.html + html, plain: current.plain + piece };
            if (current.plain.length === maxLength)
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
