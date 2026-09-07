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
export declare function escapeHtml(text: string): string;
/**
 * Convert a conservative Markdown subset to Telegram HTML: fenced code blocks
 * to `<pre>`, inline code to `<code>`, `**bold**` to `<b>`; everything else is
 * HTML-escaped. Unbalanced fences stay literal because a dangling `<pre>`
 * would make Telegram reject the message.
 * @param text - the markdown text to convert.
 * @returns Telegram-HTML text.
 */
export declare function markdownToHtml(text: string): string;
/** One independently valid Telegram message in HTML and plain-text forms. */
export interface TelegramMessageChunk {
    /** Telegram HTML whose visible text is at most the configured limit. */
    readonly html: string;
    /** Plain-text fallback for the same visible content. */
    readonly plain: string;
}
/**
 * Format and split Markdown without leaving a fenced code tag open across
 * Telegram messages.
 * @param text - markdown text to format.
 * @param maxLength - maximum visible characters per Telegram message.
 * @returns independently valid HTML chunks and their plain-text fallbacks.
 */
export declare function markdownToHtmlChunks(text: string, maxLength: number): TelegramMessageChunk[];
/**
 * Split text into chunks of at most `maxLength` characters, preferring the
 * last newline inside each window so prose breaks at line boundaries.
 * @param text - the text to split.
 * @param maxLength - the maximum chunk length (Telegram's 4096-char limit).
 * @returns one or more chunks covering the whole text.
 */
export declare function splitMessage(text: string, maxLength: number): string[];
