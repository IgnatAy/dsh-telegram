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
/** Convert the supported Markdown subset to independently splittable Telegram HTML. */
export declare function markdownToHtml(text: string): string;
/** Native Rich HTML only; never pass this output to sendMessage(parse_mode=HTML).
 * Block spacing belongs to Telegram, not literal blank lines inside paragraphs.
 * Model-supplied HTML is escaped, and images remain links rather than uploads.
 */
export declare function markdownToRichHtml(text: string): string;
/** One independently valid Telegram message in HTML and plain-text forms. */
export interface TelegramMessageChunk {
    readonly html: string;
    readonly plain: string;
}
/** Split visible text, then reopen its formatting in each independent message. */
export declare function markdownToHtmlChunks(text: string, maxLength: number): TelegramMessageChunk[];
/**
 * Split text into chunks of at most `maxLength` characters, preferring the
 * last newline inside each window so prose breaks at line boundaries.
 * @param text - the text to split.
 * @param maxLength - the maximum chunk length (Telegram's 4096-char limit).
 * @returns one or more chunks covering the whole text.
 */
export declare function splitMessage(text: string, maxLength: number): string[];
