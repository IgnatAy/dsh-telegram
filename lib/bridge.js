/**
 * Telegram→harness bridge: owns the long-polling loop, per-chat agent
 * sessions, slash commands, and delivery of assistant output back to
 * Telegram. The design mirrors Hermes' telegram platform adapter (per-chat
 * sessions, allowlist, native Rich Markdown, inline menus, typing
 * indicator), trimmed to the harness's text-first seams.
 * @module telegram/bridge
 */
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { deleteSessionLogs, requireJsonlPersistence } from './persistence.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { TelegramClient } from './client.js';
import { escapeHtml } from './format.js';
import { TelegramProgress } from './progress.js';
import { TelegramResultCache } from './result-cache.js';
const REASONING_EFFORTS = ['off', 'low', 'high', 'max'];
/** Narrow a command/config string to one supported reasoning level. */
function isReasoningEffort(value) {
    return REASONING_EFFORTS.includes(value);
}
/** Convert the controller's wire-format effort ID to the Agent's branded ID. */
function agentSelection({ selected }) {
    return {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) }),
    };
}
/** Quote runtime labels as literal inline HTML, never as executable rich markup. */
function richLiteral(value) {
    return `<code>${escapeHtml(value)}</code>`;
}
/** Use a delimiter longer than any backtick run in the literal value. */
function inlineCode(value) {
    const delimiter = '`'.repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)) + 1);
    return `${delimiter} ${value.replace(/[\r\n]+/g, ' ')} ${delimiter}`;
}
const HELP_TEXT = [
    '# 📖 命令帮助',
    '',
    '**控制面板**',
    '/menu — 打开控制面板。',
    '/new — 在当前工作区新建会话。',
    '/clear — 永久删除当前会话。',
    '',
    '**收集与排队**',
    '/collect — 开始收集多段文字与图片。',
    '/send [文字] — 提交收集内容。',
    '/discard — 放弃本次收集。',
    '/followup <消息> — 排到当前任务之后；收集模式中可直接提交全部内容。',
    '',
    '/start — 确认 Bot 在线。',
    '/help — 显示本页。',
    '/resend — 补发当前聊天最后一份未送达结果，成功后删除缓存。',
    '',
    '**发送与停止**',
    '空闲时发送消息开启任务；运行中发送消息会作为插话。图片可以附带说明，多段内容可先 /collect。停止任务请点击 Telegram 生成预览上的停止按钮。',
    '',
    '**Agent 提问**',
    '点击选项或发送自定义回答；/skip 跳过当前问题，/cancel 取消整次提问。',
].join('\n');
/** Slash-command list registered with Telegram via setMyCommands. */
const MY_COMMANDS = [
    { command: 'menu', description: '打开控制面板' },
    { command: 'start', description: '确认机器人在线' },
    { command: 'new', description: '在当前工作区新建会话' },
    { command: 'clear', description: '永久删除当前会话' },
    { command: 'collect', description: '收集多段文字与图片' },
    { command: 'send', description: '提交收集内容' },
    { command: 'discard', description: '放弃本次收集' },
    { command: 'followup', description: '将消息排到当前任务之后' },
    { command: 'resend', description: '补发最后一份未送达的缓存结果' },
    { command: 'help', description: '查看使用帮助' },
];
// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50;
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;
const QUESTION_CALLBACK_PREFIX = 'uq';
const DOWNLOAD_DIRECTORY = 'telegram-downloads';
const MAX_QUOTED_TEXT_LENGTH = 4096;
const TELEGRAM_CHANNEL_PROMPT = [
    'The human interacting with this agent is currently using a Telegram bot.',
    'Treat user inputs and quoted-message context as coming from Telegram.',
    'Keep replies suitable for Telegram text delivery and do not assume the human can see or operate Web UI controls.',
    '以下格式约束仅适用于当前 Telegram 通道的回复，不限制用户要求生成的文件内容：',
    "- 回复直接作为 Telegram Rich Markdown 发送，由 Telegram 原生解析；不要预先按 Telegram MarkdownV2 转义整段回复。支持官方 Rich HTML 扩展，不支持任意网页、CSS 或 JavaScript。",
    "- 使用 # 到 ###### 标题、段落、--- 分隔线、嵌套有序/无序列表。长回复用少量清晰小标题，段落间一个空行，不用空格或框线字符手工排版。",
    "- 行内支持 **粗体**、*斜体*、~~删除线~~、==高亮==、||剧透||、`代码`；下划线用 <u> 或 <ins>，上下标用 <sup> 与 <sub>。需要展示语法本身时放进代码块并指定语言。",
    "- 任务清单使用 - [ ] 待办事项 和 - [x] 已完成事项。它表达清单状态，不等于创建 Telegram 可协作编辑的独立 Checklist，也不自动执行任务。",
    "- LaTeX 公式使用 $...$（行内）、$$...$$（独立公式）或 math 围栏代码块；保留公式中的反斜杠，不做二次转义。也可使用 <tg-math> 和 <tg-math-block>。金额中的美元符号在有歧义时用反斜杠转义。",
    "- 表格使用标准 Markdown 表格及 :---、:---:、---: 对齐标记。手机上优先 2–3 列短字段，长解释放在表外；单元格只含行内格式。需要合并单元格或样式时可用 <table bordered striped compact>、<caption>、<tr>、<th>、<td> 及 colspan、rowspan、align、valign。",
    "- 引用使用行首 >；可用 <blockquote expandable> 创建可展开引用，用 <aside> 搭配 <cite> 创建引述。不要依赖未在官方文档定义的 [!NOTE] 等提示块；提示标题直接加粗。",
    "- 脚注使用 [^note] 与单独的 [^note]: 说明；也可用 <tg-reference name=\"note\">。锚点用 <a name=\"section\"></a>，文内跳转用 [跳转](#section)。",
    "- 链接支持 https://、mailto:、tel: 和 tg://user?id=。完整网址、邮箱、用户名、话题、命令等交给 Telegram 自动识别；不要编造用户 ID。",
    "- 折叠内容使用 <details><summary>简短摘要</summary> 加正文并闭合 </details>；加 open 可默认展开。details、tg-collage、tg-slideshow 内可继续写 Markdown，其他 HTML 块内部只能使用 HTML 排版。脚注、长推导和补充资料可放在折叠块中。",
    "- 官方 HTML 还支持 <p>、<br>、<h1> 至 <h6>、<pre><code class=\"language-python\">、<footer>、<hr/>、<ul>、<ol>、<li> 与 <input type=\"checkbox\" checked>。标签必须正确闭合，HTML 属性和普通文字里的 &、<、> 按 HTML 规则转义。",
    "- 图片、视频、音频、语音、动画和文件可用独立一段的 ![说明](https://可访问的真实媒体地址 \"标题\")，Telegram 按地址及 MIME 类型识别媒体；只提供文字链接时用 [说明](地址)。不要把本地路径当成公开 URL；不要编造媒体地址。",
    "- 显式媒体标签支持 <img>、<video>、<audio>、<tg-document>，用 <figure><figcaption> 和 <cite> 加标题和来源，tg-spoiler 可隐藏媒体。拼图用 <tg-collage>，轮播用 <tg-slideshow>。媒体必须是独立块。",
    "- 复用已上传媒体的 tg://photo?id=、tg://video?id=、tg://audio?id=、tg://document?id= 需要真实媒体映射；当前文本通道没有 multipart 上传及 media 映射工具，不要杜撰这些 ID。草稿不能新上传文件或显式通过 URL 上传文件；媒体可能要等最终消息才显示。",
    "- 地图使用 <tg-map lat=\"纬度\" long=\"经度\" zoom=\"缩放级别\"/>，只填有依据的坐标。自定义表情用 <tg-emoji emoji-id=\"真实ID\">替代文字</tg-emoji>，日期时间用 <tg-time unix=\"真实Unix秒数\" format=\"wDT\">替代文字</tg-time>，也支持官方 tg://emoji 与 tg://time 语法。",
    "- 原生按钮用 <tg-button>，按钮行用 <tg-button-row align=\"left|center|right\">。可使用 type=\"url\" 搭配 url、type=\"copy_text\" 搭配 text，或 type=\"disabled\"；样式为 primary、success、danger、link。不要用按钮代替普通正文链接。",
    "- callback_data、web_app、login_url、switch_inline_query、switch_inline_query_current_chat、switch_inline_query_chosen_chat 按钮语法会原样传给 Telegram，但需要真实应用、域名或后端处理。当前插件只处理自己的菜单和提问按钮；不要生成自定义业务回调或承诺点击能执行工具。需要用户回答时使用已有 ask_user_question 工具。",
    "- <tg-thinking> 仅用于生成中的草稿，由插件负责插入状态；不要在最终答案中输出这个标签。插件会将 dsh 已提供的思考、工具调用与结果、中间输出放入折叠记录，无需在正文重复。",
    "- 富消息上限为 32768 个 UTF-8 字符、500 个块（含嵌套列表项及表格行）、16 层嵌套、50 个媒体、20 列表格。每条回复正文尽量少于 30000 字符，为插件运行记录留空间；超长内容应组织为精简回复和用户要求的文件。插件不截断最终答案、不转普通文本、不拆坏公式或脚注；超限或不支持的服务会明确记入发送失败日志。",
].join('\n');
const IMAGE_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
};
/** Original, terse online acknowledgements inspired by Alice Kuonji's reserved witch persona. */
const START_MESSAGES = [
    '……我在。有事就说，别让我一直等着。',
    '在线。夜还很长，不过你的事最好简短一点。',
    '通信正常，茶也还热着。所以，说吧。',
    '我听见了。不必反复确认，魔女没有离开。',
    '这里是久远寺邸。至少现在，一切都很安静。',
    '……嗯。我在。趁童话还没有醒来，有什么事？',
];
/** Extract the concatenated text blocks of an assistant message. */
function assistantText(event) {
    const blocks = event.data.message.content.filter(block => block.type === 'text');
    const text = blocks.map(block => block.text).join('');
    return text === '' ? undefined : text;
}
/** A stable message string for logging, whatever the thrown shape. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Recreate DSH's serializable user-question error shape without importing the optional package. */
function userQuestionError(message, code, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.name = 'UserQuestionError';
    error.code = code;
    return error;
}
/** True when Telegram rejected an edit only because the content is unchanged. */
function isNotModified(error) {
    return /not modified/i.test(error instanceof Error ? error.message : String(error));
}
/** True when an edit/delete target is known not to exist anymore. */
function isMissingMessage(error) {
    return /message to (?:edit|delete) not found|message can't be (?:edited|deleted)/i.test(messageOf(error));
}
/** Cut progress text without leaving a dangling high surrogate. */
function truncateText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    let end = Math.max(0, maxLength - 1);
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])
        && /[\uDC00-\uDFFF]/.test(text[end])) {
        end -= 1;
    }
    return `${text.slice(0, end)}…`;
}
/** Text-bearing Telegram messages use `text`; media messages use `caption`. */
function telegramText(message) {
    return message.text ?? message.caption;
}
/** Parse a leading Telegram slash command while preserving the unsplit argument text. */
function telegramCommand(text) {
    if (text === undefined || !text.trimStart().startsWith('/'))
        return undefined;
    const trimmed = text.trim();
    const separator = trimmed.search(/\s/);
    const raw = separator < 0 ? trimmed : trimmed.slice(0, separator);
    const command = (raw.split('@')[0] ?? '').toLowerCase();
    return { command, argsText: separator < 0 ? '' : trimmed.slice(separator).trim() };
}
/** Verify the actual raster container instead of trusting Telegram MIME metadata. */
function detectImageMediaType(data) {
    if (data.length >= 8
        && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
        && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
        return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg';
    }
    if (data.length >= 12
        && String.fromCharCode(...data.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...data.slice(8, 12)) === 'WEBP') {
        return 'image/webp';
    }
    if (data.length >= 6) {
        const signature = String.fromCharCode(...data.slice(0, 6));
        if (signature === 'GIF87a' || signature === 'GIF89a')
            return 'image/gif';
    }
    return undefined;
}
/** Pick Telegram's largest advertised photo rendition. */
function largestPhoto(photo) {
    return [...photo].sort((left, right) => {
        const leftArea = left.width * left.height;
        const rightArea = right.width * right.height;
        return (right.file_size ?? 0) - (left.file_size ?? 0) || rightArea - leftArea;
    })[0];
}
/** Keep a user-facing filename while removing paths, controls, and shell-hostile punctuation. */
function safeFileStem(name) {
    const leaf = basename(name.replaceAll('\\', '/')).normalize('NFC');
    const withoutExtension = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length));
    const safe = withoutExtension
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^[-_.]+|[-_.]+$/g, '')
        .slice(0, 96);
    return safe || 'image';
}
/** Stable Telegram identities contain punctuation unsuitable for a filename. */
function activeSafeId(value) {
    return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'file';
}
/** Reject paths that escape the canonical workspace root. */
function pathInside(root, candidate) {
    const path = relative(root, candidate);
    return path === '' || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        && path !== '..' && !isAbsolute(path));
}
/** Human-readable Telegram author for quoted context. */
function telegramAuthor(message) {
    if (message.from?.username !== undefined)
        return `@${message.from.username}`;
    return message.from?.first_name;
}
/** Clearly delimit repeated material as a quote, not a fresh instruction. */
function quotedTextBlock(message, hasImage) {
    const author = telegramAuthor(message);
    const header = `[Telegram 引用消息 #${message.message_id}${author === undefined ? '' : `，来自 ${author}`}；以下仅为被引用内容]`;
    const original = telegramText(message)?.trim();
    const body = original === undefined || original === ''
        ? hasImage ? '（引用了一张图片）' : '（引用消息没有可提取的文字）'
        : truncateText(original, MAX_QUOTED_TEXT_LENGTH).split('\n').map(line => `> ${line}`).join('\n');
    return `${header}\n${body}`;
}
/** Internal routing error rendered as a user-facing unsupported-file notice. */
class UnsupportedTelegramDocumentError extends Error {
    documentMessage;
    constructor(documentMessage) {
        super('Telegram document is not a supported raster image');
        this.documentMessage = documentMessage;
    }
}
/**
 * Bridge between Telegram chats and harness agent sessions. One agent
 * session per chat; incoming text becomes a user message via `followup`,
 * and assistant messages are delivered back as native rich
 * Telegram messages. Lifecycle: {@link TelegramBridge.start} begins polling;
 * {@link TelegramBridge.stop} releases Telegram bindings and only the Agent
 * handles that this bridge created or resumed itself.
 */
export class TelegramBridge {
    ctx;
    client;
    allowedUserIds;
    allowAllUsers;
    provider;
    model;
    sleep;
    /** Agent preset id mounted on each created agent; undefined leaves the composition default. */
    preset;
    /** Default reasoning effort; undefined leaves the adapter default. */
    defaultEffort;
    chats = new Map();
    chatsBySession = new Map();
    /** Handles owned by Telegram stay live across `/menu` switches. */
    ownedAgents = new Map();
    /** Explicit `/collect` drafts keyed by Telegram private-chat id. */
    collections = new Map();
    /** Human-input requests keyed by Telegram chat id; at most one per chat. */
    resultCache;
    pendingQuestions = new Map();
    abortController = new AbortController();
    offset;
    stopped = false;
    errorCount = 0;
    disposeEvents;
    pollTask;
    menus = new Map();
    commandTask;
    stopTask;
    /**
     * @param ctx - Cordis context providing `agents` (declared by the plugin's
     * `inject`) and the session/event stream.
     * @param options - bridge options.
     */
    constructor(ctx, options) {
        const maxMessageLength = options.maxMessageLength ?? MAX_TELEGRAM_MESSAGE_LENGTH;
        if (!Number.isSafeInteger(maxMessageLength)
            || maxMessageLength < 1
            || maxMessageLength > MAX_TELEGRAM_MESSAGE_LENGTH) {
            throw new RangeError(`telegram: maxMessageLength must be an integer from 1 to ${MAX_TELEGRAM_MESSAGE_LENGTH}`);
        }
        if (options.pollingTimeoutSec !== undefined
            && (!Number.isSafeInteger(options.pollingTimeoutSec) || options.pollingTimeoutSec < 1)) {
            throw new RangeError('telegram: pollingTimeoutSec must be a positive integer');
        }
        const allowedUserIds = options.allowedUserIds ?? [];
        if (allowedUserIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
            throw new RangeError('telegram: allowedUserIds must contain only positive safe integers');
        }
        const reasoningEffort = options.reasoningEffort;
        if (reasoningEffort !== undefined
            && reasoningEffort !== ''
            && !isReasoningEffort(reasoningEffort)) {
            throw new RangeError('telegram: reasoningEffort must be off, low, high, max, or empty');
        }
        const provider = (options.provider ?? 'deepseek-official').trim();
        const model = (options.model ?? 'deepseek-v4-flash').trim();
        if (provider === '')
            throw new Error('telegram: provider must not be empty');
        if (model === '')
            throw new Error('telegram: model must not be empty');
        this.resultCache = new TelegramResultCache(options.token, options.resultCacheDirectory);
        this.ctx = ctx;
        this.client = options.client ?? new TelegramClient(options.token, {
            ...(options.pollingTimeoutSec === undefined ? {} : { pollingTimeoutSec: options.pollingTimeoutSec }),
        });
        this.allowedUserIds = new Set(allowedUserIds);
        this.allowAllUsers = options.allowAllUsers ?? false;
        this.provider = provider;
        this.model = model;
        this.preset = options.preset?.trim() || undefined;
        this.defaultEffort = reasoningEffort || undefined;
        this.sleep = options.sleep ?? ((ms, signal) => new Promise((resolve) => {
            if (signal?.aborted === true) {
                resolve();
                return;
            }
            const timer = setTimeout(done, ms);
            function done() {
                clearTimeout(timer);
                signal?.removeEventListener('abort', done);
                resolve();
            }
            signal?.addEventListener('abort', done, { once: true });
        }));
    }
    /** Register the session listener, publish the command list, and start polling. */
    start() {
        if (this.disposeEvents !== undefined || this.stopped)
            return;
        this.disposeEvents = this.ctx.on('session/event', (session, event) => {
            this.handleSessionEvent(session, event);
        });
        this.commandTask = this.registerCommands();
        this.pollTask = this.pollLoop();
    }
    /** Publish the slash-command list so Telegram's `/` menu matches the bot. */
    async registerCommands() {
        try {
            await this.client.setMyCommands(MY_COMMANDS, this.abortController.signal);
        }
        catch (error) {
            if (this.stopped)
                return;
            this.ctx.logger.warn('[telegram] setMyCommands failed: %s', messageOf(error));
        }
    }
    /** Stop polling, unregister Telegram bindings, and dispose bridge-owned Agents. */
    stop() {
        this.stopTask ??= this.stopImpl();
        return this.stopTask;
    }
    /** Perform the single lifecycle teardown shared by all `stop()` callers. */
    async stopImpl() {
        this.stopped = true;
        for (const pending of [...this.pendingQuestions.values()]) {
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted because the Telegram bridge stopped', 'ASK_ABORTED'));
        }
        this.abortController.abort();
        if (this.disposeEvents !== undefined) {
            this.disposeEvents();
            this.disposeEvents = undefined;
        }
        const entries = [...this.chatsBySession.values()];
        const owned = [...this.ownedAgents.values()];
        for (const entry of entries) {
            this.stopTyping(entry);
            entry.progress?.dispose();
        }
        await Promise.allSettled([
            ...(this.pollTask === undefined ? [] : [this.pollTask]),
            ...(this.commandTask === undefined ? [] : [this.commandTask]),
        ]);
        for (const entry of entries)
            this.stopTyping(entry);
        await Promise.allSettled(entries.map(entry => entry.queue));
        for (const entry of entries)
            entry.releaseBinding();
        this.chats.clear();
        this.chatsBySession.clear();
        this.ownedAgents.clear();
        this.collections.clear();
        this.menus.clear();
        await Promise.allSettled(owned.map(entry => entry.handle.dispose()));
    }
    async pollLoop() {
        while (!this.stopped) {
            let updates;
            try {
                updates = await this.client.getUpdates(this.offset, this.abortController.signal);
                this.errorCount = 0;
            }
            catch (error) {
                if (this.stopped)
                    return;
                this.errorCount += 1;
                this.ctx.logger.warn('[telegram] polling error (attempt %d): %s', this.errorCount, messageOf(error));
                await this.wait(Math.min(1000 * this.errorCount, 10000));
                continue;
            }
            if (this.stopped)
                return;
            for (const update of updates) {
                if (this.stopped)
                    return;
                this.offset = update.update_id + 1;
                try {
                    await this.handleUpdate(update);
                }
                catch (error) {
                    if (this.stopped)
                        return;
                    this.ctx.logger.error('[telegram] update %d failed: %s', update.update_id, messageOf(error));
                }
            }
            if (updates.length === 0)
                await this.wait(POLL_CADENCE_MS);
        }
    }
    /** Wait for the poll cadence/backoff, but release immediately during teardown. */
    async wait(ms) {
        const signal = this.abortController.signal;
        if (signal.aborted)
            return;
        let onAbort;
        const aborted = new Promise((resolve) => {
            onAbort = () => resolve();
            signal.addEventListener('abort', onAbort, { once: true });
        });
        await Promise.race([this.sleep(ms, signal), aborted]);
        if (onAbort !== undefined)
            signal.removeEventListener('abort', onAbort);
    }
    /** Cancellation for Telegram's native Stop button. */
    async stopCurrentTask(chatId) {
        const active = this.chats.get(String(chatId))?.active;
        const pending = this.pendingQuestions.get(String(chatId));
        if (active === undefined || (active.agent.status !== 'running' && pending === undefined)) {
            await this.safeSend(chatId, 'ℹ️ **当前没有正在执行的任务**');
            return;
        }
        // Kill the typing heartbeat first so Telegram's "typing…" indicator
        // dies out (~5s after the last action) instead of being renewed.
        this.stopTyping(active);
        active.progress?.stopByUser();
        // Abort the live turn with a user cancellation cause; queued
        // follow-ups are discarded too. The aborted turn/end cleans up the
        // progress message and never delivers the partial answer.
        if (pending !== undefined) {
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted by the Telegram user', 'ASK_ABORTED'));
        }
        if (active.agent.status === 'running')
            active.agent.cancel({ kind: 'user' });
        await this.enqueue(active, () => this.safeSend(chatId, '⏹ **已中断当前任务**').then(() => { }));
    }
    async handleUpdate(update) {
        const stopped = update.stopped_message_generation;
        if (stopped !== undefined) {
            // Native Stop is a chat-level request. Preview state
            // and draft IDs must not prevent cancellation of the current task.
            if (stopped.chat.type === 'private' && stopped.message_thread_id === undefined
                && (this.allowAllUsers || this.allowedUserIds.has(stopped.chat.id))) {
                await this.stopCurrentTask(stopped.chat.id);
            }
            return;
        }
        if (update.callback_query !== undefined) {
            await this.handleCallbackQuery(update.callback_query);
            return;
        }
        const message = update.message;
        if (message === undefined)
            return;
        // Group semantics (mentions, topics, and shared visibility) are not part
        // of this plugin. Ignoring them prevents an allowed user from
        // accidentally forwarding a group conversation to a private agent.
        if (message.chat.type !== 'private')
            return;
        if (!this.authorizedUser(message.from)) {
            await this.safeSend(message.chat.id, '⛔ **访问被拒绝**');
            return;
        }
        const text = telegramText(message);
        const parsed = telegramCommand(text);
        const command = parsed?.command;
        const pending = this.pendingQuestions.get(String(message.chat.id));
        if (pending !== undefined && command === '/skip') {
            this.trackTransientMessage(message.chat.id, pending.agent, message.message_id);
            await this.submitQuestionAnswer(pending, { id: this.currentQuestion(pending).id, selected: [] });
            return;
        }
        if (pending !== undefined && command === '/cancel') {
            this.trackTransientMessage(message.chat.id, pending.agent, message.message_id);
            const noticeId = await this.safeSend(message.chat.id, '🚫 **已取消提问**');
            if (noticeId !== undefined)
                this.trackTransientMessage(message.chat.id, pending.agent, noticeId);
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was cancelled by the Telegram user', 'ASK_CANCELLED'));
            return;
        }
        if (pending !== undefined) {
            if (command !== undefined) {
                await this.handleCommand(message, text ?? '');
                return;
            }
            if (message.text === undefined) {
                await this.safeSend(message.chat.id, '❓ **正在等待回答**\n请使用按钮或发送文字；图片和文件不能作为本次回答。');
                return;
            }
            this.trackTransientMessage(message.chat.id, pending.agent, message.message_id);
            await this.submitQuestionAnswer(pending, {
                id: this.currentQuestion(pending).id,
                selected: this.selectedLabels(pending),
                custom: message.text,
            });
            return;
        }
        if (command !== undefined && command !== '/followup') {
            await this.handleCommand(message, text ?? '');
            return;
        }
        if (message.document !== undefined && !this.imageDocument(message)) {
            await this.unsupportedDocument(message);
            return;
        }
        const active = this.chats.get(String(message.chat.id))?.active;
        if (active === undefined) {
            await this.safeSend(message.chat.id, '⚠️ **尚未选择会话**\n发送 /menu，选择工作区和会话，或点击“新建会话”。');
            return;
        }
        if (command === '/followup') {
            await this.handleFollowupMessage(active, message, parsed?.argsText ?? '');
            return;
        }
        const collection = this.collectionFor(active);
        if (collection !== undefined) {
            await this.addToCollection(active, collection, message);
            return;
        }
        const hasImage = this.imageCandidate(message) !== undefined;
        if (!hasImage && message.text === undefined && message.reply_to_message === undefined)
            return;
        await this.submitTelegramMessage(active, message, 'default');
    }
    authorizedUser(user) {
        if (this.allowAllUsers)
            return true;
        return user !== undefined && this.allowedUserIds.has(user.id);
    }
    async handleCommand(message, text) {
        const chatId = message.chat.id;
        const [rawCommand = '', ...args] = text.trim().split(/\s+/);
        const command = (rawCommand.split('@')[0] ?? '').toLowerCase();
        switch (command) {
            case '/start':
                await this.safeSend(chatId, `🕯 **在线**\n${START_MESSAGES[Math.floor(Math.random() * START_MESSAGES.length)]}\n\n发送 /menu 打开控制面板，或 /help 查看帮助。`);
                break;
            case '/resend':
                try {
                    const sent = await this.resultCache.resend(chatId, text => this.client.sendRichMessage(chatId, text, this.abortController.signal));
                    if (!sent)
                        await this.safeSend(chatId, '当前没有待发送的缓存结果。');
                }
                catch (error) {
                    this.ctx.logger.error('[telegram] cached result delivery failed: %s', messageOf(error));
                    await this.safeSend(chatId, '⚠️ 缓存结果补发失败，缓存仍保留，请稍后使用 /resend 重试。');
                }
                break;
            case '/menu':
                await this.showMenu(chatId);
                break;
            case '/new': {
                const state = this.chats.get(String(chatId));
                if (state?.workspace === undefined) {
                    await this.safeSend(chatId, '⚠️ **尚未选择工作区**\n请先打开 /menu 选择工作区和会话。');
                    break;
                }
                try {
                    const active = await this.createAndBind(chatId, state.workspace);
                    await this.safeSend(chatId, `✅ **已创建新会话**\n🏠 ${richLiteral(state.workspace.title)}\n💬 ${active.sessionId}`);
                }
                catch (error) {
                    await this.safeSend(chatId, `⚠️ **创建会话失败**\n${richLiteral(messageOf(error))}`);
                }
                break;
            }
            case '/clear': {
                try {
                    const deleted = await this.clearCurrent(chatId);
                    await this.safeSend(chatId, deleted === undefined
                        ? 'ℹ️ **没有可删除的会话**'
                        : `🗑 **已永久删除会话**\n${richLiteral(deleted)}\n\n工作区仍保持选中；可使用 \`/new\` 创建新会话。`);
                }
                catch (error) {
                    await this.safeSend(chatId, `⚠️ **删除会话失败**\n${richLiteral(messageOf(error))}`);
                }
                break;
            }
            case '/collect': {
                const active = this.chats.get(String(chatId))?.active;
                if (active === undefined) {
                    await this.safeSend(chatId, '⚠️ **尚未选择会话**\n请先打开 /menu 选择或新建会话。');
                    break;
                }
                const existing = this.collectionFor(active);
                if (existing !== undefined) {
                    await this.safeSend(chatId, this.collectionStatus(existing, '已经处于收集模式'));
                    break;
                }
                this.collections.set(String(chatId), {
                    chatId,
                    workspaceId: String(active.workspace.id),
                    sessionId: active.sessionId,
                    parts: [],
                    telegramMessageIds: new Set(),
                });
                await this.safeSend(chatId, '📥 **已进入收集模式**\n现在可以按任意顺序发送文字和图片。\n\n`/send` 提交 · `/followup` 排到下一轮 · `/discard` 放弃');
                break;
            }
            case '/send': {
                const active = this.chats.get(String(chatId))?.active;
                const collection = active === undefined ? undefined : this.collectionFor(active);
                if (active === undefined || collection === undefined) {
                    await this.safeSend(chatId, 'ℹ️ **当前没有收集内容**\n先使用 `/collect` 开始收集。');
                    break;
                }
                if (args.length > 0)
                    collection.parts.push({ type: 'text', text: args.join(' ') });
                await this.submitCollection(active, collection, 'default');
                break;
            }
            case '/discard': {
                const collection = this.collections.get(String(chatId));
                if (collection === undefined) {
                    await this.safeSend(chatId, 'ℹ️ **当前没有收集内容**');
                    break;
                }
                this.collections.delete(String(chatId));
                await this.safeSend(chatId, '🗑 **已放弃本次收集**\n已经下载的图片仍保留在当前工作区的 `telegram-downloads` 文件夹中。');
                break;
            }
            case '/followup':
                await this.safeSend(chatId, 'ℹ️ **/followup 用法**\n`/followup <消息>` 将消息排到当前任务之后。\n也可以回复一条文字或图片；收集模式中单独发送 `/followup` 会提交全部内容。');
                break;
            case '/help':
                await this.safeSend(chatId, HELP_TEXT);
                break;
            default:
                await this.safeSend(chatId, `❔ **未知命令**\n${richLiteral(command)}\n\n发送 \`/help\` 查看可用命令。`);
        }
    }
    /** Bind callbacks to the state shown, so an old delete cannot target a new session. */
    menuFingerprint(chatId) {
        const state = this.stateFor(chatId);
        return JSON.stringify([state.workspace?.id, state.active?.sessionId, state.preferences.selection]);
    }
    async handleMenuCallback(callback) {
        const chatId = callback.message.chat.id;
        const match = /^menu:([a-f0-9]{12}):(\d+)$/.exec(callback.data);
        const menu = this.menus.get(chatId);
        const action = match && menu?.token === match[1] && menu.messageId === callback.message.message_id
            ? menu.actions[Number(match[2])] : undefined;
        if (!menu || !action) {
            await this.safeAnswerCallback(callback.id, '菜单已失效，请重新发送 /menu。');
            return;
        }
        // Consume before awaiting anything: repeated taps cannot repeat a mutation.
        this.menus.delete(chatId);
        await this.safeAnswerCallback(callback.id);
        try {
            if (menu.fingerprint !== this.menuFingerprint(chatId)) {
                await this.showMenu(chatId, 'home', 0, undefined, '选择已变化，已刷新面板，请重新操作。', menu.messageId);
                return;
            }
            await action();
        }
        catch (error) {
            await this.showMenu(chatId, 'home', 0, undefined, `操作失败：${messageOf(error)}`, menu.messageId);
        }
    }
    /** Paginated snapshot: callbacks capture stable IDs, never live catalog positions. */
    async showMenu(chatId, view = 'home', page = 0, workspaceId, notice, messageId) {
        try {
            const state = this.stateFor(chatId);
            const [catalog, info] = await Promise.all([this.loadCatalog(), this.currentModelInfoOrUndefined(state)]);
            const token = randomUUID().replaceAll('-', '').slice(0, 12);
            const actions = [];
            const rows = [];
            const button = (text, action) => {
                const index = actions.push(action) - 1;
                return { text: this.buttonLabel(text), callback_data: `menu:${token}:${index}` };
            };
            const navigate = (next, nextPage = 0, id) => this.showMenu(chatId, next, nextPage, id, undefined, messageId);
            const lines = [
                '# 🎛 控制面板',
                this.formatSelectionSummary(state, info, catalog),
                '---',
                '## 📊 运行状态',
                [
                    '| 项目 | 状态 |',
                    '| --- | --- |',
                    `| 任务 | ${state.active?.agent.status === 'running' ? '运行中' : state.active ? '空闲' : '未连接会话'} |`,
                    `| 等待回答 | ${this.pendingQuestions.has(String(chatId)) ? '是' : '否'} |`,
                    `| 收集模式 | ${this.collections.has(String(chatId)) ? `已收集 ${this.collections.get(String(chatId)).parts.length} 项` : '关闭'} |`,
                    `| 现有工作区 / 会话 | ${catalog.length} / ${catalog.reduce((sum, entry) => sum + entry.sessions.length, 0)} |`,
                ].join('\n'),
                '---',
            ];
            if (notice)
                lines.push(`**提示**　${richLiteral(notice)}`);
            const idle = () => {
                if (state.active?.agent.status === 'running')
                    throw new Error('任务仍在运行，请等待完成或点击 Telegram 原生停止按钮后再操作。');
            };
            const paginate = (items, render) => {
                const pages = Math.max(1, Math.ceil(items.length / 8));
                page = Math.max(0, Math.min(page, pages - 1));
                lines.push(`第 ${page + 1} / ${pages} 页`);
                const start = lines.length;
                items.slice(page * 8, page * 8 + 8).forEach(render);
                const entries = lines.splice(start);
                if (entries.length)
                    lines.push(entries.join('\n'));
                if (pages > 1) {
                    const navigation = [];
                    if (page > 0)
                        navigation.push(button('⬅️ 上一页', () => navigate(view, page - 1, workspaceId)));
                    if (page + 1 < pages)
                        navigation.push(button('下一页 ➡️', () => navigate(view, page + 1, workspaceId)));
                    rows.push(navigation);
                }
            };
            const chooseSession = async (entry, sessionId) => {
                idle();
                const fresh = await this.loadCatalog();
                const index = fresh.findIndex(candidate => candidate.workspace.id === entry.workspace.id);
                if (index < 0)
                    throw new Error('工作区已移除，请刷新菜单。');
                const sessionIndex = sessionId === undefined ? -1 : fresh[index].sessions.findIndex(session => String(session.id) === sessionId);
                if (sessionId !== undefined && sessionIndex < 0)
                    throw new Error('会话已移除，请刷新菜单。');
                await this.useCatalogSelection(chatId, index + 1, sessionIndex + 1, fresh);
                await navigate('home');
            };
            if (view === 'home') {
                lines.push('使用下方按钮管理会话与模型，面板会在原消息中更新。');
                rows.push([button('🗂 工作区与会话', () => navigate('workspaces')), button('🤖 切换模型', () => navigate('models'))]);
                rows.push([button('🧠 推理强度', () => navigate('reasoning'))]);
                rows.push([button('➕ 新建会话', async () => {
                        idle();
                        if (!state.workspace) {
                            await navigate('workspaces');
                            return;
                        }
                        await this.createAndBind(chatId, state.workspace);
                        await navigate('home');
                    }), button('🗑 删除会话', () => navigate('delete'))]);
            }
            else if (view === 'workspaces') {
                lines.push('', '## 🗂 现有工作区');
                if (!catalog.length)
                    lines.push('暂无已登记工作区，请先在 Web UI 中添加。');
                paginate(catalog, entry => {
                    lines.push(`- **${richLiteral(entry.workspace.title)}** · ${entry.sessions.length} 个会话\n  ${inlineCode(entry.workspace.path)}`);
                    rows.push([button(`${state.workspace?.id === entry.workspace.id ? '✓ ' : ''}${entry.workspace.title}`, () => navigate('sessions', 0, String(entry.workspace.id)))]);
                });
            }
            else if (view === 'sessions') {
                const entry = catalog.find(item => String(item.workspace.id) === workspaceId);
                if (!entry)
                    throw new Error('工作区已移除，请刷新菜单。');
                lines.push('', `## 💬 ${richLiteral(entry.workspace.title)} 的会话`);
                if (!entry.sessions.length)
                    lines.push('暂无会话，可点击下方按钮新建。');
                paginate(entry.sessions, session => {
                    const label = session.title || String(session.id);
                    const badges = `${session.archived ? ' · 已归档' : ''}${session.error ? ' · 读取失败' : ''}${state.active?.sessionId === String(session.id) ? ' · 当前' : ''}`;
                    lines.push(`- ${richLiteral(label)}${badges}\n  ${inlineCode(String(session.id))}`);
                    rows.push([button(`${label}${badges}`, () => chooseSession(entry, String(session.id)))]);
                });
                rows.push([button('➕ 在此工作区新建会话', () => chooseSession(entry)), button('⬅️ 工作区', () => navigate('workspaces'))]);
            }
            else if (view === 'models') {
                const models = await this.loadModelCatalog(state);
                lines.push('', '## 🤖 可用模型', '切换模型后，推理强度恢复为该模型默认值。');
                paginate(models, model => {
                    const selected = model.provider === state.preferences.selection.provider && model.id === state.preferences.selection.model;
                    lines.push(`- ${richLiteral(model.name)}${selected ? ' · **当前**' : ''}${model.inputModalities?.includes('image') ? ' · 支持图片' : ''}`);
                    rows.push([button(`${selected ? '✓ ' : ''}${model.name}`, async () => {
                            idle();
                            const next = { provider: model.provider, model: model.id };
                            await this.ctx.llm.resolveCallConfig(next, this.abortController.signal);
                            await this.applyChatSelection(state, next);
                            await navigate('home');
                        })]);
                });
            }
            else if (view === 'reasoning') {
                const modelInfo = await this.resolveCurrentModel(state);
                const choices = this.reasoningChoices(modelInfo);
                const selectedEffort = state.preferences.selection.reasoningEffort ?? modelInfo.reasoning?.defaultEffort;
                lines.push('', '## 🧠 可用推理强度');
                if (!choices.length)
                    lines.push('当前模型不支持切换推理强度。');
                paginate(choices, choice => {
                    lines.push(`- ${richLiteral(choice.name)}${choice.description ? ` — ${richLiteral(choice.description)}` : ''}`);
                    rows.push([button(`${selectedEffort === choice.effort ? '✓ ' : ''}${choice.name}`, async () => {
                            idle();
                            const current = state.preferences.selection;
                            const next = { provider: current.provider, model: current.model, ...(choice.effort === undefined ? {} : { reasoningEffort: choice.effort }) };
                            await this.ctx.llm.resolveCallConfig(next, this.abortController.signal);
                            await this.applyChatSelection(state, next);
                            await navigate('home');
                        })]);
                });
            }
            else if (view === 'delete') {
                if (!state.active)
                    lines.push('', '当前没有可删除的会话。');
                else {
                    lines.push('', '**确认永久删除上方当前会话？此操作不可撤销。**');
                    rows.push([button('确认永久删除', async () => {
                            idle();
                            await this.clearCurrent(chatId);
                            await navigate('home');
                        }), button('取消', () => navigate('home'))]);
                }
            }
            rows.push([button(view === 'home' ? '🔄 刷新状态' : '🏠 返回总览', () => navigate('home'))]);
            const old = this.menus.get(chatId);
            const sent = messageId === undefined
                ? await this.client.sendRichMessage(chatId, lines.filter(Boolean).join('\n\n'), this.abortController.signal, { inline_keyboard: rows })
                : await this.client.editRichMessage(chatId, messageId, lines.filter(Boolean).join('\n\n'), this.abortController.signal, { inline_keyboard: rows });
            messageId = sent.message_id;
            this.menus.set(chatId, { token, messageId: sent.message_id, fingerprint: this.menuFingerprint(chatId), actions });
            if (old && old.messageId !== sent.message_id) {
                try {
                    await this.client.editMessageReplyMarkup(chatId, old.messageId, { inline_keyboard: [] }, this.abortController.signal);
                }
                catch (error) {
                    this.ctx.logger.warn('[telegram] old menu cleanup failed: %s', messageOf(error));
                }
            }
        }
        catch (error) {
            await this.safeSend(chatId, `⚠️ **菜单暂时不可用**\n${richLiteral(messageOf(error))}\n请重新发送 /menu。`);
        }
    }
    /** Return only a draft that still belongs to the exact active session. */
    collectionFor(active) {
        const key = String(active.chatId);
        const collection = this.collections.get(key);
        if (collection === undefined)
            return undefined;
        if (collection.sessionId === active.sessionId
            && collection.workspaceId === String(active.workspace.id))
            return collection;
        this.collections.delete(key);
        return undefined;
    }
    /** Summarize an in-progress collection without exposing internal attachment ids. */
    collectionStatus(collection, prefix = '已加入收集') {
        const textCount = collection.parts.filter(part => part.type === 'text' && part.text.trim() !== '').length;
        const imageCount = collection.parts.filter(part => part.type === 'image').length;
        return `📥 **${prefix}**\n文字 ${textCount} 段 · 图片 ${imageCount} 张\n\n`
            + '`/send` 提交 · `/followup` 排到下一轮 · `/discard` 放弃';
    }
    /** Telegram documents are admitted only when their declaration plausibly names a supported raster. */
    imageDocument(message) {
        const document = message.document;
        if (document === undefined)
            return false;
        const mime = document.mime_type?.toLowerCase();
        if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif')
            return true;
        const extension = extname(document.file_name ?? '').toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension);
    }
    /** Extract one full-resolution download candidate from a Telegram message. */
    imageCandidate(message) {
        const photo = message.photo === undefined ? undefined : largestPhoto(message.photo);
        if (photo !== undefined) {
            return {
                fileId: photo.file_id,
                fileUniqueId: photo.file_unique_id,
                fileSize: photo.file_size,
                suggestedName: `telegram-photo-${message.message_id}.jpg`,
                telegramMessageId: message.message_id,
            };
        }
        const document = message.document;
        if (document === undefined || !this.imageDocument(message))
            return undefined;
        return {
            fileId: document.file_id,
            fileUniqueId: document.file_unique_id,
            fileSize: document.file_size,
            suggestedName: document.file_name ?? `telegram-image-${message.message_id}`,
            telegramMessageId: message.message_id,
        };
    }
    /** Explain the native DSH attachment boundary instead of silently dropping a document. */
    async unsupportedDocument(message) {
        const document = message.document;
        const label = document?.file_name ?? document?.mime_type ?? '该文件';
        await this.safeSend(message.chat.id, `🚫 **不支持此文件**\n${richLiteral(truncateText(label, 160))}\n\n当前只接受 PNG、JPEG、WebP、GIF 图片；PDF、DOCX、压缩包、音频和视频不会发送给 Agent。`);
    }
    /** Explicit `/followup`: submit one message, or submit the active collection as a later turn. */
    async handleFollowupMessage(active, message, argsText) {
        const collection = this.collectionFor(active);
        if (collection !== undefined) {
            const hasAttachedContent = this.imageCandidate(message) !== undefined
                || message.reply_to_message !== undefined
                || argsText !== '';
            if (hasAttachedContent) {
                const added = await this.addToCollection(active, collection, message, argsText, false);
                if (!added)
                    return;
            }
            await this.submitCollection(active, collection, 'followup');
            return;
        }
        const hasContent = argsText !== ''
            || this.imageCandidate(message) !== undefined
            || message.reply_to_message !== undefined;
        if (!hasContent) {
            await this.safeSend(message.chat.id, 'ℹ️ **/followup 用法**\n发送 `/followup <消息>`，或回复一条文字/图片消息后发送 `/followup`。');
            return;
        }
        await this.submitTelegramMessage(active, message, 'followup', argsText);
    }
    /** Add one Telegram message and its reply context to an explicit collection. */
    async addToCollection(active, collection, message, overrideText, announce = true) {
        if (message.document !== undefined && !this.imageDocument(message)) {
            await this.unsupportedDocument(message);
            return false;
        }
        try {
            const parts = await this.telegramMessageParts(active, message, overrideText);
            if (parts.length === 0) {
                await this.safeSend(message.chat.id, 'ℹ️ **没有可收集的内容**\n这条消息没有文字或受支持图片。');
                return false;
            }
            const currentImages = collection.parts.filter(part => part.type === 'image');
            const addedImages = parts.filter((part) => part.type === 'image');
            const limits = this.ctx.attachments.imageLimits;
            if (currentImages.length + addedImages.length > limits.maxImagesPerMessage) {
                await this.safeSend(message.chat.id, `⚠️ **图片数量超过限制**\n当前最多 ${limits.maxImagesPerMessage} 张。`);
                return false;
            }
            const totalBytes = [...currentImages, ...addedImages]
                .reduce((sum, part) => sum + part.image.data.byteLength, 0);
            if (totalBytes > limits.maxMessageImageBytes) {
                await this.safeSend(message.chat.id, '⚠️ **图片总大小超过当前 DSH 限制**');
                return false;
            }
            collection.parts.push(...parts);
            collection.telegramMessageIds.add(message.message_id);
            if (announce)
                await this.safeSend(message.chat.id, this.collectionStatus(collection));
            return true;
        }
        catch (error) {
            if (error instanceof UnsupportedTelegramDocumentError) {
                await this.unsupportedDocument(error.documentMessage);
            }
            else {
                await this.safeSend(message.chat.id, `⚠️ **收集失败**\n${richLiteral(messageOf(error))}`);
            }
            return false;
        }
    }
    /** Submit and clear one collection only after DSH has accepted it. */
    async submitCollection(active, collection, mode) {
        if (collection.parts.length === 0) {
            await this.safeSend(active.chatId, 'ℹ️ **收集内容为空**\n请先发送文字或图片。');
            return;
        }
        try {
            await this.submitParts(active, collection.parts, mode);
            this.collections.delete(String(active.chatId));
            await this.safeSend(active.chatId, mode === 'followup' ? '🕒 **已加入后续任务队列**' : '✅ **已提交收集内容**');
        }
        catch (error) {
            await this.safeSend(active.chatId, `⚠️ **提交收集内容失败**\n${richLiteral(messageOf(error))}\n\n内容仍保留在收集模式中。`);
        }
    }
    /** Build and submit one ordinary Telegram message. */
    async submitTelegramMessage(active, message, mode, overrideText) {
        try {
            const parts = await this.telegramMessageParts(active, message, overrideText);
            if (parts.length === 0)
                return;
            await this.submitParts(active, parts, mode);
        }
        catch (error) {
            if (error instanceof UnsupportedTelegramDocumentError) {
                await this.unsupportedDocument(error.documentMessage);
            }
            else {
                await this.safeSend(message.chat.id, `⚠️ **消息处理失败**\n${richLiteral(messageOf(error))}`);
            }
        }
    }
    /**
     * Preserve Telegram reply semantics inside the same DSH user message. Quoted
     * text is explicitly delimited, and quoted images remain adjacent to that
     * delimiter, so no context can leak into a different turn.
     */
    async telegramMessageParts(active, message, overrideText) {
        if (message.document !== undefined && !this.imageDocument(message)) {
            throw new UnsupportedTelegramDocumentError(message);
        }
        const parts = [];
        const reply = message.reply_to_message;
        if (reply !== undefined) {
            if (reply.document !== undefined && !this.imageDocument(reply)) {
                throw new UnsupportedTelegramDocumentError(reply);
            }
            const replyCandidate = this.imageCandidate(reply);
            parts.push({ type: 'text', text: quotedTextBlock(reply, replyCandidate !== undefined) });
            if (replyCandidate !== undefined) {
                const image = await this.downloadWorkspaceImage(active, replyCandidate);
                parts.push({ type: 'text', text: `[Telegram 引用图片已保存到工作区：${image.relativePath}]` });
                parts.push({ type: 'image', image });
            }
        }
        const candidate = this.imageCandidate(message);
        if (candidate !== undefined) {
            const image = await this.downloadWorkspaceImage(active, candidate);
            parts.push({ type: 'text', text: `[Telegram 图片已保存到工作区：${image.relativePath}]` });
            parts.push({ type: 'image', image });
        }
        const currentText = overrideText === undefined ? telegramText(message)?.trim() : overrideText.trim();
        if (currentText !== undefined && currentText !== '') {
            parts.push({ type: 'text', text: currentText });
        }
        else if (reply !== undefined && candidate === undefined) {
            parts.push({ type: 'text', text: '请继续处理我在 Telegram 中引用的内容。' });
        }
        return parts;
    }
    /** Download, verify, and save one image beneath the selected workspace. */
    async downloadWorkspaceImage(active, candidate) {
        const limits = this.ctx.attachments.imageLimits;
        if (candidate.fileSize !== undefined && candidate.fileSize > limits.maxImageBytes) {
            throw new Error(`图片超过当前单张大小限制（${limits.maxImageBytes} 字节）`);
        }
        const downloaded = await this.client.downloadFile(candidate.fileId, limits.maxImageBytes, this.abortController.signal);
        const mediaType = detectImageMediaType(downloaded.data);
        if (mediaType === undefined || !limits.mediaTypes.includes(mediaType)) {
            throw new Error('文件内容不是 DSH 支持的 PNG、JPEG、WebP 或 GIF 图片');
        }
        const name = `${safeFileStem(candidate.suggestedName)}${IMAGE_EXTENSIONS[mediaType]}`;
        await this.ctx.attachments.validateImage({ data: downloaded.data, mediaType, name });
        const stored = await this.saveWorkspaceFile(active.workspace, candidate, name, downloaded.data);
        return {
            data: downloaded.data,
            mediaType,
            name,
            absolutePath: stored.absolutePath,
            relativePath: stored.relativePath,
            telegramMessageId: candidate.telegramMessageId,
        };
    }
    /** Create an exclusive file under `<workspace>/telegram-downloads` without following an escaping directory link. */
    async saveWorkspaceFile(workspace, candidate, name, data) {
        const workspaceRoot = await realpath(workspace.path);
        const requestedRoot = join(workspaceRoot, DOWNLOAD_DIRECTORY);
        await mkdir(requestedRoot, { recursive: true });
        const root = await realpath(requestedRoot);
        if (!pathInside(workspaceRoot, root)) {
            throw new Error(`下载目录逃离了当前工作区：${requestedRoot}`);
        }
        const stem = safeFileStem(name);
        const extension = extname(name);
        const identity = `${activeSafeId(candidate.fileUniqueId)}-${candidate.telegramMessageId}`;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
            const filename = `${identity}-${stem}${suffix}${extension}`;
            const absolutePath = join(root, filename);
            if (!pathInside(root, absolutePath))
                throw new Error('生成的下载文件名不在下载目录中');
            let file;
            try {
                file = await open(absolutePath, 'wx', 0o600);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    continue;
                throw error;
            }
            try {
                await file.writeFile(data);
            }
            finally {
                await file.close();
            }
            return { absolutePath, relativePath: relative(workspaceRoot, absolutePath) };
        }
        throw new Error('无法为 Telegram 下载生成不冲突的文件名');
    }
    /** Admit collected rasters, preserve their order, then choose steer vs. follow-up. */
    async submitParts(active, parts, mode) {
        const images = parts.filter((part) => part.type === 'image');
        if (images.length > 0) {
            const info = await this.resolveCurrentModel(this.stateFor(active.chatId));
            if (info.inputModalities?.includes('image') !== true) {
                throw new Error(`当前模型 ${info.name} 不支持图片输入；请先打开 /menu 切换到支持图片的模型`);
            }
        }
        const refs = images.length === 0
            ? []
            : await this.ctx.attachments.saveImages(images.map(part => ({
                data: part.image.data,
                mediaType: part.image.mediaType,
                name: part.image.name,
            })));
        let imageIndex = 0;
        const content = parts.flatMap((part) => {
            if (part.type === 'text')
                return part.text.trim() === '' ? [] : [{ type: 'text', text: part.text }];
            const attachment = refs[imageIndex];
            imageIndex += 1;
            return attachment === undefined ? [] : [{ type: 'image', attachment }];
        });
        if (content.length === 0)
            throw new Error('消息没有可提交的内容');
        const input = createUserMessage({ content, source: { kind: 'user' } });
        if (mode === 'followup' || active.agent.status !== 'running') {
            active.agent.followup(input);
        }
        else {
            active.agent.steer(input);
        }
    }
    /** Return a chat state without selecting a workspace or creating an Agent. */
    stateFor(chatId) {
        const key = String(chatId);
        const existing = this.chats.get(key);
        if (existing !== undefined)
            return existing;
        const state = {
            chatId,
            workspace: undefined,
            active: undefined,
            preferences: {
                selection: {
                    provider: this.provider,
                    model: this.model,
                    ...(this.defaultEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(this.defaultEffort) }),
                },
            },
        };
        this.chats.set(key, state);
        return state;
    }
    /** Read the adapter-owned model catalog and retain the current route if it is unlisted. */
    async loadModelCatalog(state) {
        const providers = this.ctx.llm.listProviders();
        const groups = await Promise.all(providers.map(async (provider) => {
            try {
                return (await this.ctx.llm.listModels(provider.id)).map(model => ({
                    ...model,
                    providerName: provider.name,
                }));
            }
            catch (error) {
                this.ctx.logger.warn('[telegram] model catalog for provider %s failed: %s', provider.id, messageOf(error));
                return [];
            }
        }));
        const catalog = groups.flat();
        const current = state.preferences.selection;
        if (!catalog.some(model => model.provider === current.provider && model.id === current.model)) {
            let resolved;
            try {
                resolved = await this.ctx.llm.resolveModelInfo(current.provider, current.model, this.abortController.signal);
            }
            catch {
                // The current configured route still belongs in the selector even if
                // its adapter/catalog is temporarily unavailable.
            }
            const providerName = providers.find(provider => provider.id === current.provider)?.name ?? current.provider;
            catalog.unshift({
                provider: current.provider,
                id: current.model,
                name: resolved?.name ?? '当前模型（名称暂不可用）',
                providerName,
                ...(resolved?.description === undefined ? {} : { description: resolved.description }),
                ...(resolved?.inputModalities === undefined ? {} : { inputModalities: resolved.inputModalities }),
            });
        }
        return catalog;
    }
    /** Resolve exact metadata for the model currently selected by one chat. */
    resolveCurrentModel(state) {
        const current = state.preferences.selection;
        return this.ctx.llm.resolveModelInfo(current.provider, current.model, this.abortController.signal);
    }
    /** Resolve display metadata without preventing unrelated selectors from rendering. */
    async currentModelInfoOrUndefined(state) {
        try {
            return await this.resolveCurrentModel(state);
        }
        catch (error) {
            const current = state.preferences.selection;
            this.ctx.logger.warn('[telegram] current model metadata for %s/%s failed: %s', current.provider, current.model, messageOf(error));
            return undefined;
        }
    }
    /** Apply one route to chat-owned selection or the official selection of a borrowed Agent. */
    async applyChatSelection(state, selection) {
        const active = state.active;
        if (active === undefined || this.ownedAgents.has(active.sessionId)) {
            state.preferences.selection = { ...selection };
            return;
        }
        const result = await this.ctx.sessionController.selectModel({
            sessionId: active.agent.session.id,
            ...selection,
        });
        state.preferences.selection = agentSelection(result);
    }
    /** Render the current selection shared by menu pages. */
    formatSelectionSummary(state, info, workspaces) {
        const selection = state.preferences.selection;
        const model = info?.name ?? '当前模型（名称暂不可用）';
        const effort = selection.reasoningEffort ?? info?.reasoning?.defaultEffort;
        const effortInfo = info?.reasoning?.efforts.find(candidate => candidate.id === effort);
        const reasoning = effortInfo?.name ?? effort ?? (info === undefined ? '暂不可用' : info.reasoning === undefined ? '不支持' : '未知');
        let session = state.active === undefined
            ? '未选择'
            : state.active.sessionTitle === undefined
                ? inlineCode(state.active.sessionId)
                : `${richLiteral(state.active.sessionTitle)}（${inlineCode(state.active.sessionId)}）`;
        if (state.active !== undefined && workspaces !== undefined) {
            const catalogSession = workspaces
                .flatMap(workspace => workspace.sessions)
                .find(candidate => String(candidate.id) === state.active?.sessionId);
            const title = catalogSession?.title?.replace(/\s+/g, ' ').trim();
            if (title !== undefined && title !== '')
                session = `${richLiteral(title)}（${inlineCode(state.active.sessionId)}）`;
        }
        return [
            '## 🎯 当前选择',
            '',
            `- **工作区**：${state.workspace === undefined ? '未选择' : richLiteral(state.workspace.title)}`,
            ...(state.workspace === undefined ? [] : [`  ${inlineCode(state.workspace.path)}`]),
            `- **会话**：${session}`,
            `- **模型**：${richLiteral(model)}`,
            `- **思考强度**：${richLiteral(reasoning)}`,
        ].join('\n');
    }
    /** Offer only the exact effort ids exposed by the selected model. */
    reasoningChoices(info) {
        return (info.reasoning?.efforts ?? []).map(effort => ({
            effort: effort.id,
            name: effort.name,
            description: effort.description,
        }));
    }
    /** Build the current numbered workspace/session catalog. */
    async loadCatalog() {
        const signal = this.abortController.signal;
        const workspaces = this.ctx.workspaceRegistry.list();
        const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(String));
        const sessions = new Map();
        // Read only registered sessions and release each observation promptly.
        for (const id of new Set(workspaces.flatMap(workspace => [...workspace.sessionIds]))) {
            try {
                const observation = await this.ctx.sessionQuery.observeSession(id, { signal, projectionMode: 'none' });
                try {
                    sessions.set(String(id), {
                        id,
                        header: observation.header,
                        title: foldSessionTitle(observation.events)?.title,
                        archived: archived.has(String(id)),
                    });
                }
                finally {
                    observation[Symbol.dispose]();
                }
            }
            catch (error) {
                signal.throwIfAborted();
                this.ctx.logger.warn('[telegram] read for session %s failed: %s', id, messageOf(error));
                sessions.set(String(id), { id, title: undefined, error: messageOf(error), archived: archived.has(String(id)) });
            }
        }
        return workspaces.map(workspace => ({
            workspace,
            sessions: workspace.sessionIds.flatMap(id => {
                const session = sessions.get(String(id));
                return session === undefined ? [] : [session];
            }),
        }));
    }
    /** Resolve one numbered selection and bind the Telegram chat to it. */
    async useCatalogSelection(chatId, workspaceNumber, sessionNumber, catalog) {
        const entry = catalog[workspaceNumber - 1];
        if (entry === undefined)
            throw new Error(`工作区编号 ${workspaceNumber} 不存在，请重新打开 /menu`);
        if (sessionNumber === 0) {
            const active = await this.createAndBind(chatId, entry.workspace);
            return `✅ **已创建并进入会话**\n🏠 ${entry.workspace.title}\n💬 ${active.sessionId}`;
        }
        const selected = entry.sessions[sessionNumber - 1];
        if (selected === undefined) {
            throw new Error(`「${entry.workspace.title}」中没有会话编号 ${sessionNumber}，请重新打开 /menu`);
        }
        if (selected.header === undefined) {
            throw new Error(`会话 ${selected.id} 读取失败：${selected.error ?? '没有可用的会话信息'}`);
        }
        const state = this.stateFor(chatId);
        if (state.active?.sessionId === String(selected.id)) {
            state.workspace = entry.workspace;
            return `ℹ️ **当前已在该会话中**\n🏠 ${entry.workspace.title}\n💬 ${selected.id}`;
        }
        const owner = this.chatsBySession.get(String(selected.id));
        if (owner !== undefined && owner.chatId !== chatId) {
            throw new Error('该会话正在被另一个 Telegram 私聊使用');
        }
        const agent = await this.resolveAgentForUse(chatId, selected.id, state.preferences, selected.header.agentPreset ?? this.preset);
        const active = this.activeSession(chatId, entry.workspace, agent, selected.title);
        try {
            await this.bind(state, active);
        }
        catch (error) {
            active.releaseBinding();
            throw error;
        }
        const label = selected.title === undefined ? String(selected.id) : `「${selected.title}」`;
        return `✅ **会话已切换**\n🏠 ${entry.workspace.title}\n💬 ${label}`;
    }
    /** Create, attach, and bind a new session in an existing workspace. */
    async createAndBind(chatId, workspace) {
        if (await workspace.status() !== 'ok')
            throw new Error(`工作区目录不存在：${workspace.path}`);
        const state = this.stateFor(chatId);
        const sessionId = SessionId(`telegram:${chatId}:${randomUUID()}`);
        const handle = await this.ctx.agents.create({
            sessionId,
            meta: { cwd: workspace.path, ...(this.preset === undefined ? {} : { agentPreset: this.preset }) },
            agentOptions: {
                provider: state.preferences.selection.provider,
                model: state.preferences.selection.model,
            },
            signal: this.abortController.signal,
            setup: this.makeSetup(state.preferences, this.preset),
        });
        this.ownedAgents.set(String(sessionId), { chatId, handle });
        let attached = false;
        let active;
        try {
            await workspace.attachSession(sessionId);
            attached = true;
            active = this.activeSession(chatId, workspace, handle.agent);
            await this.bind(state, active);
            return active;
        }
        catch (error) {
            active?.releaseBinding();
            if (attached && state.active?.sessionId !== String(sessionId)) {
                try {
                    await workspace.detachSession(sessionId);
                }
                catch (rollbackError) {
                    this.ctx.logger.error('[telegram] failed to detach session %s after create rollback: %s', sessionId, messageOf(rollbackError));
                }
            }
            this.ownedAgents.delete(String(sessionId));
            await handle.dispose();
            throw error;
        }
    }
    /** Reuse a global live Agent or resume one Agent owned by this bridge. */
    async resolveAgentForUse(chatId, sessionId, preferences, preset) {
        const key = String(sessionId);
        const live = this.ctx.agents.get(sessionId);
        if (live !== undefined) {
            await this.prepareLiveAgent(chatId, key, live, preferences);
            return live;
        }
        try {
            const handle = await this.ctx.agents.resume({
                resumeSessionId: sessionId,
                agentOptions: {
                    provider: preferences.selection.provider,
                    model: preferences.selection.model,
                },
                signal: this.abortController.signal,
                setup: this.makeSetup(preferences, preset),
            });
            this.ownedAgents.set(key, { chatId, handle });
            return handle.agent;
        }
        catch (error) {
            const raced = this.ctx.agents.get(sessionId);
            if (raced === undefined)
                throw error;
            await this.prepareLiveAgent(chatId, key, raced, preferences);
            return raced;
        }
    }
    /** Validate ownership and apply this chat's model route to a borrowed live Agent. */
    async prepareLiveAgent(chatId, sessionId, agent, preferences) {
        const owned = this.ownedAgents.get(sessionId);
        if (owned !== undefined) {
            if (owned.chatId !== chatId) {
                throw new Error('该会话由另一个 Telegram 私聊保持运行');
            }
            return;
        }
        const result = await this.ctx.sessionController.selectModel({
            sessionId: agent.session.id,
            ...preferences.selection,
        });
        preferences.selection = agentSelection(result);
    }
    /** Initialize delivery bookkeeping and Telegram-only bindings for one Agent. */
    activeSession(chatId, workspace, agent, sessionTitle) {
        return {
            chatId,
            workspace,
            agent,
            sessionId: String(agent.session.id),
            sessionTitle,
            transientMessageIds: new Set(),
            latestAssistantMessageIds: [],
            queue: Promise.resolve(),
            typingTimer: undefined,
            releaseBinding: this.attachTelegramBinding(chatId, agent),
        };
    }
    /** Publish a replacement binding only after the previous Agent is quiescent. */
    async bind(state, replacement) {
        if (this.stopped) {
            throw new Error('telegram bridge stopped during agent binding');
        }
        await this.releaseActive(state);
        if (this.stopped)
            throw new Error('telegram bridge stopped during agent binding');
        state.workspace = replacement.workspace;
        state.active = replacement;
        this.chatsBySession.set(replacement.sessionId, replacement);
    }
    /** Forget the Telegram binding while leaving the global Agent lifecycle intact. */
    async releaseActive(state) {
        const active = state.active;
        if (active === undefined)
            return;
        this.collections.delete(String(state.chatId));
        const pending = this.pendingQuestions.get(String(state.chatId));
        if (pending !== undefined && pending.agent === active.agent) {
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted because the Telegram session changed', 'ASK_ABORTED'));
        }
        state.active = undefined;
        this.chatsBySession.delete(active.sessionId);
        this.stopTyping(active);
        active.progress?.dispose();
        await active.queue;
        try {
            await this.cleanupTurnMessages(active, true);
        }
        finally {
            active.releaseBinding();
        }
    }
    /** Delete the current durable JSONL log and detach it from its workspace. */
    async clearCurrent(chatId) {
        const state = this.chats.get(String(chatId));
        const active = state?.active;
        if (state === undefined || active === undefined)
            return undefined;
        const owned = this.ownedAgents.get(active.sessionId);
        if (owned === undefined || owned.handle.agent !== active.agent) {
            throw new Error('当前会话由 DSH 其他界面保持运行，Telegram 无法安全地永久删除它');
        }
        const header = active.agent.session.header;
        const storage = requireJsonlPersistence(this.ctx.sessionPersistence);
        await this.releaseActive(state);
        await owned.handle.dispose();
        this.ownedAgents.delete(active.sessionId);
        await deleteSessionLogs(storage, header.id, () => active.workspace.detachSession(header.id), this.abortController.signal);
        return String(header.id);
    }
    /**
     * Agent setup hook: mount the preset and install the per-chat model route.
     * Telegram-only channel and question listeners are attached by `bind()` so
     * switching sessions can remove them without destroying the Agent.
     */
    makeSetup(preferences, preset) {
        return async (agentCtx) => {
            const presets = this.ctx.get('agentPresets');
            if (presets === undefined) {
                throw new Error('telegram: agentPresets service is required to compose chat agents');
            }
            await presets.mount(agentCtx, preset);
            installModelSelection(agentCtx, {
                get current() {
                    return { ...preferences.selection };
                },
                set current(_next) { },
                assembled: undefined,
            });
        };
    }
    /** Attach the channel prompt and question transport for one current chat binding. */
    attachTelegramBinding(chatId, agent) {
        const disposePrompt = agent.ctx.systemPrompt.context({
            name: 'telegram:channel',
            order: 900,
            text: TELEGRAM_CHANNEL_PROMPT,
        });
        let disposeQuestions;
        let disposeStream;
        try {
            disposeStream = agent.ctx.on('agent/assistant-stream', ({ frame }) => {
                const active = this.chats.get(String(chatId))?.active;
                if (active?.agent === agent)
                    active.progress?.stream(frame);
            });
            const questionEvents = agent.ctx;
            disposeQuestions = questionEvents.on('user-questions/request', (request, next) => {
                const active = this.chats.get(String(chatId))?.active;
                if (active === undefined || active.agent !== agent)
                    return next();
                return this.askThroughTelegram(chatId, agent, request);
            }, { prepend: true });
        }
        catch (error) {
            disposeStream?.();
            disposePrompt();
            throw error;
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            disposeQuestions?.();
            disposeStream?.();
            disposePrompt();
        };
    }
    /** Claim one DSH user-question request for the currently bound Telegram chat. */
    askThroughTelegram(chatId, agent, request) {
        if (request.signal?.aborted === true || this.stopped) {
            return Promise.reject(userQuestionError('ask_user_question was aborted before the Telegram user answered', 'ASK_ABORTED'));
        }
        if (request.questions.length === 0) {
            return Promise.reject(userQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS'));
        }
        const key = String(chatId);
        if (this.pendingQuestions.has(key)) {
            return Promise.reject(userQuestionError('another ask_user_question request is already waiting in this Telegram chat', 'ASK_BUSY'));
        }
        return new Promise((resolve, reject) => {
            const pending = {
                chatId,
                agent,
                token: randomUUID().replaceAll('-', '').slice(0, 12),
                questions: request.questions,
                answers: [],
                resolve,
                reject,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
                index: 0,
                selectedIndices: new Set(),
                keyboardMessageId: undefined,
                onAbort: undefined,
                settled: false,
            };
            pending.onAbort = () => {
                this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted before the Telegram user answered', 'ASK_ABORTED'));
            };
            request.signal?.addEventListener('abort', pending.onAbort, { once: true });
            this.pendingQuestions.set(key, pending);
            this.chats.get(key)?.active?.progress?.suspend();
            void this.presentQuestion(pending).catch((error) => {
                const aborted = request.signal?.aborted === true || this.stopped;
                this.rejectPendingQuestion(pending, userQuestionError(aborted
                    ? 'ask_user_question was aborted before the Telegram user answered'
                    : `could not deliver ask_user_question to Telegram: ${messageOf(error)}`, aborted ? 'ASK_ABORTED' : 'ASK_DELIVERY_FAILED', error));
            });
        });
    }
    /** Handle one inline-keyboard choice and always dismiss Telegram's callback spinner. */
    async handleCallbackQuery(callback) {
        const message = callback.message;
        if (message === undefined || message.chat.type !== 'private' || callback.data === undefined) {
            await this.safeAnswerCallback(callback.id, '这个按钮不可用。', true);
            return;
        }
        if (!this.authorizedUser(callback.from)) {
            await this.safeAnswerCallback(callback.id, 'Access denied.', true);
            return;
        }
        if (callback.data.startsWith('menu:')) {
            await this.handleMenuCallback(callback);
            return;
        }
        const match = /^uq:([a-f0-9]{12}):(\d+):(o\d+|d|u|s|c)$/.exec(callback.data);
        const pending = this.pendingQuestions.get(String(message.chat.id));
        if (match === null
            || pending === undefined
            || match[1] !== pending.token
            || Number(match[2]) !== pending.index
            || message.message_id !== pending.keyboardMessageId) {
            await this.safeAnswerCallback(callback.id, '这个问题已经失效。');
            return;
        }
        const question = this.currentQuestion(pending);
        const action = match[3];
        if (action.startsWith('o')) {
            const optionIndex = Number(action.slice(1));
            const option = question.options?.[optionIndex];
            if (option === undefined) {
                await this.safeAnswerCallback(callback.id, '这个选项已经失效。');
                return;
            }
            if (question.multiSelect === true) {
                if (pending.selectedIndices.has(optionIndex))
                    pending.selectedIndices.delete(optionIndex);
                else
                    pending.selectedIndices.add(optionIndex);
                await this.safeAnswerCallback(callback.id);
                await this.refreshQuestionKeyboard(pending);
                return;
            }
            await this.safeAnswerCallback(callback.id, `已选择：${option.label}`);
            await this.submitQuestionAnswer(pending, { id: question.id, selected: [option.label] });
            return;
        }
        if (action === 'd') {
            if (question.multiSelect !== true) {
                await this.safeAnswerCallback(callback.id, '这个按钮已经失效。');
                return;
            }
            const selected = this.selectedLabels(pending);
            if (selected.length === 0) {
                await this.safeAnswerCallback(callback.id, '请至少选择一项，或点“跳过”。');
                return;
            }
            await this.safeAnswerCallback(callback.id, '已提交选择。');
            await this.submitQuestionAnswer(pending, { id: question.id, selected });
            return;
        }
        if (action === 'u') {
            await this.safeAnswerCallback(callback.id);
            await this.requestCustomAnswer(pending);
            return;
        }
        if (action === 's') {
            await this.safeAnswerCallback(callback.id, '已跳过。');
            await this.submitQuestionAnswer(pending, { id: question.id, selected: [] });
            return;
        }
        await this.safeAnswerCallback(callback.id, '已取消提问。');
        this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was cancelled by the Telegram user', 'ASK_CANCELLED'));
    }
    /** Send the current item, attaching buttons or a Telegram ForceReply composer. */
    async presentQuestion(pending) {
        if (pending.settled)
            return;
        const active = this.chats.get(String(pending.chatId))?.active;
        if (active === undefined || active.agent !== pending.agent) {
            throw userQuestionError('the Telegram session changed before the question was shown', 'ASK_ABORTED');
        }
        this.stopTyping(active);
        const question = this.currentQuestion(pending);
        const hasOptions = (question.options?.length ?? 0) > 0;
        const replyMarkup = hasOptions
            ? this.questionKeyboard(pending)
            : {
                force_reply: true,
                input_field_placeholder: '请输入回答，或发送 /skip 跳过',
                selective: true,
            };
        const sent = await this.client.sendRichMessage(pending.chatId, this.formatQuestion(pending), this.questionSignal(pending), replyMarkup);
        this.trackTransientMessage(pending.chatId, pending.agent, sent.message_id);
        if (hasOptions) {
            pending.keyboardMessageId = sent.message_id;
            if (pending.settled)
                await this.clearQuestionKeyboard(pending);
        }
    }
    /** Render a question with all details visible even when button labels must be shortened. */
    formatQuestion(pending) {
        const question = this.currentQuestion(pending);
        const heading = question.header?.trim()
            || (question.intent?.kind === 'plan-review' ? '方案确认' : 'Agent 需要你的回答');
        const lines = [
            `❓ **${heading}**`,
            `问题 ${pending.index + 1} / ${pending.questions.length}`,
            '',
            question.question,
        ];
        if (question.detail !== undefined && question.detail.trim() !== '') {
            lines.push('', question.detail);
        }
        const options = question.options ?? [];
        if (options.length > 0) {
            lines.push('', '**选项**');
            options.forEach((option, index) => {
                lines.push(`**${index + 1}. ${option.label}**${option.description === undefined ? '' : `\n└ ${option.description}`}`);
            });
            lines.push('', question.multiSelect === true
                ? '💡 可选择多项，选好后点“完成”；也可直接输入补充或自定义回答。'
                : '💡 请选择一项；也可直接输入自定义回答。');
        }
        else {
            lines.push('', '💡 请直接回复这条消息。发送 `/skip` 可跳过，发送 `/cancel` 可取消整次提问。');
        }
        return lines.join('\n');
    }
    /** Build the current keyboard; multi-select choices show their checked state. */
    questionKeyboard(pending) {
        const question = this.currentQuestion(pending);
        const buttons = (question.options ?? []).map((option, index) => [{
                text: this.buttonLabel(`${pending.selectedIndices.has(index) ? '✓ ' : ''}${index + 1}. ${option.label}`),
                callback_data: this.questionCallbackData(pending, `o${index}`),
            }]);
        if (question.multiSelect === true) {
            buttons.push([
                { text: '完成', callback_data: this.questionCallbackData(pending, 'd') },
                { text: '✍️ 自定义', callback_data: this.questionCallbackData(pending, 'u') },
            ]);
        }
        else {
            buttons.push([{ text: '✍️ 自定义回答', callback_data: this.questionCallbackData(pending, 'u') }]);
        }
        buttons.push([
            { text: '跳过', callback_data: this.questionCallbackData(pending, 's') },
            { text: '取消提问', callback_data: this.questionCallbackData(pending, 'c') },
        ]);
        return { inline_keyboard: buttons };
    }
    questionCallbackData(pending, action) {
        return `${QUESTION_CALLBACK_PREFIX}:${pending.token}:${pending.index}:${action}`;
    }
    /** Keep button text readable without risking an oversized keyboard label. */
    buttonLabel(text) {
        const characters = [...text];
        return characters.length <= 56 ? text : `${characters.slice(0, 55).join('')}…`;
    }
    /** Enter free-text mode after a user explicitly presses the custom-answer button. */
    async requestCustomAnswer(pending) {
        if (pending.settled)
            return;
        await this.clearQuestionKeyboard(pending);
        try {
            const sent = await this.client.sendRichMessage(pending.chatId, '✍️ **请输入自定义回答**\n若刚才已勾选多项，你的文字会作为补充一并提交。', this.questionSignal(pending), { force_reply: true, input_field_placeholder: '输入自定义回答', selective: true });
            this.trackTransientMessage(pending.chatId, pending.agent, sent.message_id);
        }
        catch (error) {
            this.rejectPendingQuestion(pending, userQuestionError(`could not request a custom Telegram answer: ${messageOf(error)}`, 'ASK_DELIVERY_FAILED', error));
        }
    }
    /** Store one answer and either present the next question or resume the Agent. */
    async submitQuestionAnswer(pending, answer) {
        if (pending.settled || answer.id !== this.currentQuestion(pending).id)
            return;
        await this.clearQuestionKeyboard(pending);
        if (pending.settled)
            return;
        pending.answers.push(answer);
        pending.index += 1;
        pending.selectedIndices = new Set();
        if (pending.index >= pending.questions.length) {
            this.resolvePendingQuestion(pending);
            return;
        }
        try {
            await this.presentQuestion(pending);
        }
        catch (error) {
            this.rejectPendingQuestion(pending, userQuestionError(`could not deliver ask_user_question to Telegram: ${messageOf(error)}`, pending.signal?.aborted === true ? 'ASK_ABORTED' : 'ASK_DELIVERY_FAILED', error));
        }
    }
    currentQuestion(pending) {
        const question = pending.questions[pending.index];
        if (question === undefined)
            throw new Error('telegram: pending question index is out of bounds');
        return question;
    }
    /** Abort question delivery when either the bridge or the DSH request ends. */
    questionSignal(pending) {
        return pending.signal === undefined
            ? this.abortController.signal
            : AbortSignal.any([this.abortController.signal, pending.signal]);
    }
    selectedLabels(pending) {
        const options = this.currentQuestion(pending).options ?? [];
        return [...pending.selectedIndices]
            .sort((left, right) => left - right)
            .flatMap(index => options[index] === undefined ? [] : [options[index].label]);
    }
    /** Update checkmarks after toggling a multi-select option. */
    async refreshQuestionKeyboard(pending) {
        const messageId = pending.keyboardMessageId;
        if (messageId === undefined || pending.settled)
            return;
        try {
            await this.client.editMessageReplyMarkup(pending.chatId, messageId, this.questionKeyboard(pending), this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped && !isNotModified(error) && !isMissingMessage(error)) {
                this.ctx.logger.warn('[telegram] question keyboard update failed: %s', messageOf(error));
            }
        }
    }
    /** Remove an old keyboard so it cannot submit an answer twice. */
    async clearQuestionKeyboard(pending) {
        const messageId = pending.keyboardMessageId;
        pending.keyboardMessageId = undefined;
        if (messageId === undefined)
            return;
        try {
            await this.client.editMessageReplyMarkup(pending.chatId, messageId, undefined, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped && !isNotModified(error) && !isMissingMessage(error)) {
                this.ctx.logger.warn('[telegram] question keyboard removal failed: %s', messageOf(error));
            }
        }
    }
    resolvePendingQuestion(pending) {
        if (!this.settlePendingQuestion(pending))
            return;
        const active = this.chats.get(String(pending.chatId))?.active;
        if (active !== undefined && active.agent === pending.agent
            && active.agent.status === 'running') {
            void this.safeAction(pending.chatId, 'typing');
            this.startTyping(active);
            active.progress?.resume();
        }
        pending.resolve({ answers: pending.answers });
    }
    rejectPendingQuestion(pending, error) {
        if (!this.settlePendingQuestion(pending))
            return;
        void this.clearQuestionKeyboard(pending);
        const active = this.chats.get(String(pending.chatId))?.active;
        if (active?.agent === pending.agent)
            active.progress?.resume();
        pending.reject(error);
    }
    /** Atomically remove a pending request and its abort listener. */
    settlePendingQuestion(pending) {
        if (pending.settled)
            return false;
        pending.settled = true;
        if (this.pendingQuestions.get(String(pending.chatId)) === pending) {
            this.pendingQuestions.delete(String(pending.chatId));
        }
        if (pending.onAbort !== undefined)
            pending.signal?.removeEventListener('abort', pending.onAbort);
        return true;
    }
    /** Callback acknowledgements are best-effort but never omitted. */
    async safeAnswerCallback(callbackId, text, showAlert) {
        try {
            await this.client.answerCallbackQuery(callbackId, text === undefined ? undefined : truncateText(text, 200), showAlert, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.warn('[telegram] callback acknowledgement failed: %s', messageOf(error));
        }
    }
    handleSessionEvent(session, event) {
        const chat = this.chatFor(session);
        if (chat === undefined)
            return;
        switch (event.type) {
            case 'turn/start':
                chat.progress?.dispose();
                void this.safeAction(chat.chatId, 'typing');
                void this.enqueue(chat, () => this.onTurnStart(chat));
                chat.progress = new TelegramProgress(this.client, chat.chatId, this.abortController.signal, task => this.enqueue(chat, task), error => this.ctx.logger.warn('[telegram] preview failed: %s', messageOf(error)), chat.workspace.path);
                break;
            case 'assistant/message': {
                chat.progress?.pause();
                chat.progress?.event(event);
                const text = assistantText(event);
                if (text !== undefined) {
                    const richMarkdown = chat.progress?.finalMarkdown(text);
                    void this.enqueue(chat, () => this.onAssistantText(chat, text, richMarkdown));
                }
                break;
            }
            case 'turn/end': {
                const notice = chat.progress?.terminalNotice(event.data.reason?.kind ?? 'completed');
                const final = event.data.reason?.kind === 'aborted' ? undefined : chat.progress?.finishMarkdown(notice);
                chat.progress?.dispose();
                void this.enqueue(chat, async () => {
                    this.stopTyping(chat);
                    if (final !== undefined)
                        await this.onAssistantText(chat, final);
                    await this.onTurnEnd(chat, event, final === undefined ? notice : undefined);
                });
                break;
            }
            default:
                chat.progress?.event(event);
                break;
        }
    }
    /** Serialize per-chat session-event side effects; never lets them interleave. */
    enqueue(chat, task) {
        chat.queue = chat.queue.then(task).catch((error) => {
            if (!this.stopped)
                this.ctx.logger.error('[telegram] session event failed: %s', messageOf(error));
        });
        return chat.queue;
    }
    /** Turn start: remove artifacts from an unbalanced previous turn, then show typing. */
    async onTurnStart(chat) {
        await this.cleanupTurnMessages(chat, true);
        chat.latestDeliveryFailed = false;
        this.startTyping(chat);
    }
    /** Send each complete assistant step as a fresh message instead of editing prior output. */
    async onAssistantText(chat, text, richMarkdown) {
        for (const messageId of chat.latestAssistantMessageIds) {
            chat.transientMessageIds.add(messageId);
        }
        // Native Rich Markdown is the only assistant delivery path. Rejections and
        // ambiguous transport failures keep the disk cache for explicit /resend,
        // never an automatic retry with a reduced format.
        chat.latestDeliveryFailed = true;
        const sent = await this.resultCache.deliver(chat.chatId, richMarkdown ?? text, markdown => this.client.sendRichMessage(chat.chatId, markdown, this.abortController.signal));
        chat.latestDeliveryFailed = false;
        chat.latestAssistantMessageIds = [sent.message_id];
    }
    /**
     * Turn finished: the latest assistant step is already visible as the final
     * answer, so remove every prior output and interaction artifact. An aborted
     * turn has no final answer and removes the latest partial output too.
     */
    async onTurnEnd(chat, event, notice) {
        this.stopTyping(chat);
        const aborted = event.data.reason?.kind === 'aborted';
        if (notice !== undefined)
            await this.onAssistantText(chat, notice);
        if (!chat.latestDeliveryFailed)
            await this.cleanupTurnMessages(chat, aborted);
    }
    /** Add a bot or user interaction message to the current turn's cleanup set. */
    trackTransientMessage(chatId, agent, messageId) {
        const active = this.chats.get(String(chatId))?.active;
        if (active !== undefined && active.agent === agent) {
            active.transientMessageIds.add(messageId);
        }
    }
    /** Delete turn artifacts, optionally including the latest partial/final assistant step. */
    async cleanupTurnMessages(chat, includeLatest) {
        const latest = chat.latestAssistantMessageIds;
        const keep = includeLatest ? new Set() : new Set(latest);
        const remove = new Set([...chat.transientMessageIds].filter(messageId => !keep.has(messageId)));
        if (includeLatest) {
            for (const messageId of latest)
                remove.add(messageId);
        }
        chat.transientMessageIds.clear();
        chat.latestAssistantMessageIds = [];
        await this.deleteMessageIds(chat.chatId, [...remove]);
    }
    /** Delete turn artifacts in Bot API batches. */
    async deleteMessageIds(chatId, messageIds) {
        const unique = [...new Set(messageIds)];
        for (let offset = 0; offset < unique.length; offset += 100) {
            try {
                await this.client.deleteMessages(chatId, unique.slice(offset, offset + 100), this.abortController.signal);
            }
            catch (error) {
                if (this.stopped)
                    return;
                if (!isMissingMessage(error))
                    this.ctx.logger.warn('[telegram] turn cleanup failed: %s', messageOf(error));
            }
        }
    }
    /** Keep Telegram's typing indicator alive while a turn runs (the action expires after ~5s). */
    startTyping(chat) {
        this.stopTyping(chat);
        chat.typingTimer = setInterval(() => {
            void this.safeAction(chat.chatId, 'typing');
        }, 4000);
    }
    /** Stop the typing heartbeat for a chat. */
    stopTyping(chat) {
        if (chat.typingTimer !== undefined) {
            clearInterval(chat.typingTimer);
            chat.typingTimer = undefined;
        }
    }
    chatFor(session) {
        return this.chatsBySession.get(String(session.id));
    }
    /** Fixed notices use the same native Rich Markdown transport as assistant replies. */
    async safeSend(chatId, text) {
        try {
            const sent = await this.client.sendRichMessage(chatId, text, this.abortController.signal);
            return sent.message_id;
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error));
            return undefined;
        }
    }
    async safeAction(chatId, action) {
        try {
            await this.client.sendChatAction(chatId, action, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.warn('[telegram] chat action %s failed: %s', action, messageOf(error));
        }
    }
}
