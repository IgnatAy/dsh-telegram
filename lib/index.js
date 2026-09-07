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
import Schema from '@deepseek-ai/schemastery';
import { TelegramBridge } from './bridge.js';
export * from './bridge.js';
export * from './client.js';
export * from './format.js';
export const name = 'telegram';
// Chat agents must join a preset before publication so their tools, prompt
// sections, and skills are scoped exactly like Web-created agents.
export const inject = [
    'agents',
    'agentPresets',
    'attachments',
    'llm',
    'sessionController',
    'sessionPersistence',
    'sessionQuery',
    'systemPrompt',
    'workspaceRegistry',
];
export const Config = Schema.object({
    // The schema default keeps the field present; an empty value falls back to
    // the DSH_TELEGRAM_TOKEN environment variable in apply.
    token: Schema.string().default(''),
    allowedUserIds: Schema.array(Schema.natural().min(1)).default([]),
    allowAllUsers: Schema.boolean(),
    provider: Schema.string().min(1).default('deepseek-official'),
    model: Schema.string().min(1).default('deepseek-v4-flash'),
    maxMessageLength: Schema.natural().min(1).max(4096).default(4096),
    pollingTimeoutSec: Schema.natural().min(1).default(30),
    preset: Schema.string().min(1).default('standard'),
    reasoningEffort: Schema.union(['', 'off', 'low', 'high', 'max']).default(''),
});
/** Env var carrying a comma-separated Telegram user id allowlist. */
const ALLOWED_USER_IDS_ENV = 'DSH_TELEGRAM_ALLOWED_USER_IDS';
/** Env var opting into open access (development only). */
const ALLOW_ALL_USERS_ENV = 'DSH_TELEGRAM_ALLOW_ALL_USERS';
/** Parse the comma-separated allowlist env var; `undefined` when unset. */
function envAllowedUserIds() {
    const raw = process.env[ALLOWED_USER_IDS_ENV];
    if (raw === undefined || raw === '')
        return undefined;
    const values = raw.split(',').map(value => value.trim());
    const invalid = values.find(value => value === ''
        || !Number.isSafeInteger(Number(value))
        || Number(value) <= 0);
    if (invalid !== undefined) {
        throw new Error(`${ALLOWED_USER_IDS_ENV} must contain comma-separated positive integer user ids`);
    }
    return [...new Set(values.map(Number))];
}
/** Parse the optional open-access environment flag. */
function envAllowAllUsers() {
    const raw = process.env[ALLOW_ALL_USERS_ENV];
    if (raw === undefined || raw === '')
        return undefined;
    if (raw === 'true')
        return true;
    if (raw === 'false')
        return false;
    throw new Error(`${ALLOW_ALL_USERS_ENV} must be "true" or "false"`);
}
/**
 * Start the Telegram bridge. Missing tokens fail loudly at load; polling and
 * session delivery run for as long as the plugin's fiber lives.
 * @param ctx - Cordis context; Agent, preset, LLM, persistence, query, and
 * Session Controller and workspace services are injected by the plugin declaration.
 * @param config - deployment config.
 */
export async function apply(ctx, config) {
    const configuredToken = config.token?.trim();
    const token = configuredToken === undefined || configuredToken === ''
        ? process.env.DSH_TELEGRAM_TOKEN?.trim()
        : configuredToken;
    if (token === undefined || token === '') {
        throw new Error('telegram: missing bot token (set config.token or DSH_TELEGRAM_TOKEN)');
    }
    // Config wins; the env vars are the profile-friendly fallback (same pattern
    // as the token), so a profile can deploy the bot with environment only.
    const allowedUserIds = (config.allowedUserIds?.length ?? 0) > 0
        ? config.allowedUserIds
        : envAllowedUserIds() ?? [];
    const allowAllUsers = config.allowAllUsers ?? envAllowAllUsers() ?? false;
    const preset = (await ctx.agentPresets.resolve(config.preset)).id;
    const bridge = new TelegramBridge(ctx, { ...config, token, allowedUserIds, allowAllUsers, preset });
    ctx.effect(() => {
        bridge.start();
        return () => bridge.stop();
    }, 'telegram.serve');
}
