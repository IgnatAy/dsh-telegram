/**
 * Minimal Telegram Bot API client over `fetch`: long-polling `getUpdates`,
 * `sendMessage` with HTML or plain parse modes, `sendChatAction`, and `getMe`.
 * The token is embedded in the request URL, so every error path redacts it.
 * @module telegram/client
 */
/** Replace the token with a placeholder in an error text. */
function redactToken(text, token) {
    return text.split(token).join('***');
}
/** Strip the bot token from any thrown value before it is logged. */
function redactedMessage(error, token) {
    const text = error instanceof Error ? error.message : String(error);
    return redactToken(text, token);
}
/**
 * Minimal Bot API client. All methods throw on transport failure or a
 * non-`ok` response; thrown messages never contain the token.
 */
export class TelegramClient {
    token;
    fetchImpl;
    baseUrl;
    /** Long-polling timeout in seconds; controls each getUpdates call. */
    pollingTimeoutSec;
    /**
     * @param token - bot token from @BotFather.
     * @param options - client options.
     */
    constructor(token, options = {}) {
        const normalizedToken = token.trim();
        if (normalizedToken === '')
            throw new Error('telegram client: token must not be empty');
        const pollingTimeoutSec = options.pollingTimeoutSec ?? 30;
        if (!Number.isSafeInteger(pollingTimeoutSec) || pollingTimeoutSec < 1) {
            throw new Error('telegram client: pollingTimeoutSec must be a positive integer');
        }
        this.token = normalizedToken;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
        this.pollingTimeoutSec = pollingTimeoutSec;
    }
    url(method) {
        return `${this.baseUrl}/bot${this.token}/${method}`;
    }
    /** Build a token-bearing download URL; callers must redact every failure path. */
    fileUrl(filePath) {
        return `${this.baseUrl}/file/bot${this.token}/${filePath.replace(/^\/+/, '')}`;
    }
    /** POST `method` with `body`; throws on transport failure or a non-ok response. */
    async call(method, body, signal) {
        let response;
        try {
            response = await this.fetchImpl(this.url(method), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal,
            });
        }
        catch (error) {
            throw new Error(`telegram ${method} transport error: ${redactedMessage(error, this.token)}`);
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            payload = null;
        }
        if (!response.ok || payload?.ok !== true) {
            const description = payload?.description
                ?? (payload === null ? `invalid JSON response (HTTP ${response.status})` : `HTTP ${response.status}`);
            throw new Error(`telegram ${method} failed: ${redactToken(description, this.token)}`);
        }
        if (!Object.hasOwn(payload, 'result')) {
            throw new Error(`telegram ${method} failed: response omitted result`);
        }
        return payload.result;
    }
    /**
     * Fetch the bot identity; fails when the token is invalid.
     * @returns the bot user object.
     */
    getMe(signal) {
        return this.call('getMe', {}, signal);
    }
    /**
     * Long-poll for message and callback updates. Pass the previous update id plus one to
     * acknowledge already-seen updates; `undefined` asks for any pending update.
     * @param offset - the update id to start from.
     * @returns the batch of updates received within the polling timeout.
     */
    getUpdates(offset, signal) {
        const body = {
            timeout: this.pollingTimeoutSec,
            allowed_updates: ['message', 'callback_query'],
        };
        if (offset !== undefined)
            body.offset = offset;
        return this.call('getUpdates', body, signal);
    }
    /**
     * Send a text message, optionally with HTML parse mode.
     * @param chatId - target chat id.
     * @param text - the message text.
     * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
     * @returns the delivered message object.
     */
    sendMessage(chatId, text, parseMode, signal, replyMarkup) {
        const body = { chat_id: chatId, text };
        if (parseMode !== undefined)
            body.parse_mode = parseMode;
        if (replyMarkup !== undefined)
            body.reply_markup = replyMarkup;
        return this.call('sendMessage', body, signal);
    }
    /**
     * Send a chat action such as `typing`; Telegram shows it briefly while a
     * real message is on the way.
     * @param chatId - target chat id.
     * @param action - the action name (for example `typing`).
     * @returns whether the action was accepted.
     */
    sendChatAction(chatId, action, signal) {
        return this.call('sendChatAction', { chat_id: chatId, action }, signal);
    }
    /**
     * Register the bot's slash-command list; Telegram shows it in the `/` menu.
     * @param commands - `{ command, description }` pairs (command without the leading slash).
     * @returns whether the registration was accepted.
     */
    setMyCommands(commands, signal) {
        return this.call('setMyCommands', { commands }, signal);
    }
    editMessageText(chatId, messageId, text, parseMode, signal) {
        const body = { chat_id: chatId, message_id: messageId, text };
        if (parseMode !== undefined)
            body.parse_mode = parseMode;
        return this.call('editMessageText', body, signal);
    }
    editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }, signal) {
        return this.call('editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: replyMarkup,
        }, signal);
    }
    answerCallbackQuery(callbackQueryId, text, showAlert, signal) {
        const body = { callback_query_id: callbackQueryId };
        if (text !== undefined)
            body.text = text;
        if (showAlert !== undefined)
            body.show_alert = showAlert;
        return this.call('answerCallbackQuery', body, signal);
    }
    deleteMessage(chatId, messageId, signal) {
        return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }, signal);
    }
    deleteMessages(chatId, messageIds, signal) {
        if (messageIds.length < 1 || messageIds.length > 100) {
            throw new RangeError('telegram deleteMessages: messageIds must contain from 1 to 100 entries');
        }
        return this.call('deleteMessages', {
            chat_id: chatId,
            message_ids: [...messageIds],
        }, signal);
    }
    /**
     * Resolve a Telegram `file_id` and download it without ever buffering more
     * than the caller-approved limit. The public Bot API currently imposes its
     * own 20 MiB ceiling; a local Bot API server may allow more.
     */
    async downloadFile(fileId, maxBytes, signal) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new RangeError('telegram downloadFile: maxBytes must be a positive safe integer');
        }
        const file = await this.call('getFile', { file_id: fileId }, signal);
        if (file.file_path === undefined || file.file_path === '') {
            throw new Error('telegram getFile failed: response omitted file_path');
        }
        if (file.file_size !== undefined && file.file_size > maxBytes) {
            throw new Error(`telegram downloadFile failed: file exceeds ${maxBytes} bytes`);
        }
        let response;
        try {
            response = await this.fetchImpl(this.fileUrl(file.file_path), { signal });
        }
        catch (error) {
            throw new Error(`telegram downloadFile transport error: ${redactedMessage(error, this.token)}`);
        }
        if (!response.ok) {
            throw new Error(`telegram downloadFile failed: HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            try {
                await response.body?.cancel();
            }
            catch { /* best-effort release */ }
            throw new Error(`telegram downloadFile failed: file exceeds ${maxBytes} bytes`);
        }
        const reader = response.body?.getReader();
        if (reader === undefined)
            throw new Error('telegram downloadFile failed: response omitted body');
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done)
                    break;
                length += next.value.byteLength;
                if (length > maxBytes) {
                    await reader.cancel();
                    throw new Error(`telegram downloadFile failed: file exceeds ${maxBytes} bytes`);
                }
                chunks.push(next.value);
            }
        }
        catch (error) {
            const redacted = redactedMessage(error, this.token);
            if (/telegram downloadFile failed:/.test(redacted))
                throw new Error(redacted);
            throw new Error(`telegram downloadFile transport error: ${redacted}`);
        }
        finally {
            reader.releaseLock();
        }
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return { file, data };
    }
}
