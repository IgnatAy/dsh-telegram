/**
 * Telegram bridge plugin: relays Telegram chats to harness agent sessions
 * through the Bot API's long polling. Copied from Hermes' telegram platform
 * adapter design — per-chat sessions, user allowlist, HTML formatting,
 * 4096-char splitting, and a typing indicator — trimmed to the harness's
 * text-first seams. The selected DSH profile supplies the LLM adapter,
 * agent spine, sessions, and tools.
 *
 * @module telegram
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { TelegramBridgeOptions } from './bridge.js';
export * from './bridge.js';
export * from './client.js';
export * from './format.js';
export declare const name = "telegram";
export declare const inject: string[];
/** Telegram bridge deployment config. */
export interface TelegramConfig extends Omit<TelegramBridgeOptions, 'token'> {
    /** Bot token; omitted values fall back to the `DSH_TELEGRAM_TOKEN` env var. */
    token?: string;
}
export declare const Config: Schema<TelegramConfig>;
/**
 * Start the Telegram bridge. Missing tokens fail loudly at load; polling and
 * session delivery run for as long as the plugin's fiber lives.
 * @param ctx - Cordis context; Agent, preset, LLM, persistence, query, and
 * Session Controller and workspace services are injected by the plugin declaration.
 * @param config - deployment config.
 */
export declare function apply(ctx: Context, config: TelegramConfig): Promise<void>;
