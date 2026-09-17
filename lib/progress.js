import { randomInt } from 'node:crypto';
import { TelegramApiError } from './client.js';
import { escapeHtml } from './format.js';
/** Bound preview text without cutting a UTF-16 surrogate pair. Final answers are never clipped. */
function clip(text, limit) {
    if (text.length <= limit)
        return text;
    let end = limit - 1;
    if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? ''))
        end--;
    return `${text.slice(0, end)}…`;
}
/**
 * One turn's disposable preview. Events mutate bounded state synchronously; a
 * coalescer sends only the latest snapshot through the bridge's delivery queue.
 * No tool arguments or result bodies are copied into the preview.
 */
export class TelegramProgress {
    client;
    chatId;
    enqueue;
    warn;
    draftId = randomInt(1, 2 ** 31);
    started = Date.now();
    abort = new AbortController();
    signal;
    timer;
    attempt;
    revision = -1;
    text = '';
    phase = '正在思考';
    tools = [];
    completed = 0;
    history = [];
    latestTextEntries = new Set();
    latestAnswer = '';
    lastPublished = '';
    paused = false;
    waitingForUser = false;
    disposed = false;
    stoppedByUser = false;
    scheduled = false;
    epoch = 0;
    dirty = true;
    nextSend = 0;
    lastSent = 0;
    constructor(client, chatId, signal, enqueue, warn) {
        this.client = client;
        this.chatId = chatId;
        this.enqueue = enqueue;
        this.warn = warn;
        this.signal = AbortSignal.any([signal, this.abort.signal]);
        this.timer = setInterval(() => this.schedule(), 1200);
        this.schedule();
    }
    /** Reject old attempts and revisions, including late chunks after a retry. */
    stream(frame) {
        if (this.disposed || frame.revision <= this.revision)
            return;
        this.revision = frame.revision;
        if (frame.type === 'start') {
            this.attempt = frame.attemptId;
            this.text = '';
            this.phase = '正在思考';
            this.changed();
        }
        else if (frame.attemptId === this.attempt && frame.type === 'chunk') {
            if (frame.chunk.type === 'text-delta') {
                this.text = clip(this.text + frame.chunk.text, 16000);
                this.phase = '正在生成回复';
            }
            else if (frame.chunk.type === 'reasoning-delta') {
                this.phase = '正在思考';
            }
            else if (frame.chunk.type === 'tool-call-delta') {
                this.phase = '正在准备工具调用';
            }
            else
                return;
            this.changed();
        }
        else if (frame.attemptId === this.attempt && frame.type === 'end'
            && (frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt')) {
            this.text = '';
            this.phase = '正在等待重试';
            this.changed();
        }
    }
    event(event) {
        if (this.disposed)
            return;
        if (event.type === 'assistant/message') {
            this.latestTextEntries.clear();
            this.latestAnswer = '';
            for (const block of event.data.message.content) {
                if (block.type === 'reasoning' || block.type === 'text') {
                    if (block.type === 'text') {
                        this.latestTextEntries.add(this.history.length);
                        this.latestAnswer += block.text;
                    }
                    this.history.push({ title: block.type === 'reasoning' ? '思考' : '中间输出', text: block.text });
                }
            }
        }
        else if (event.type === 'tool/call') {
            this.history.push({ title: `工具调用 · ${event.data.name}`, text: event.data.arguments });
            // Keep active calls plus a bounded recent history.
            this.tools = this.tools.filter((tool, index) => tool.ended === undefined || index >= this.tools.length - 12);
            this.tools.push({ id: event.data.callId, name: clip(event.data.name, 80), started: event.time });
            this.text = '';
            this.phase = '正在执行工具';
            this.changed();
        }
        else if (event.type === 'tool/result') {
            for (const block of event.data.message.content) {
                if (block.type !== 'tool-result')
                    continue;
                this.history.push({
                    title: `工具结果 · ${this.tools.find(tool => tool.id === block.toolCallId)?.name ?? block.toolCallId}${block.isError ? ' · 失败' : ''}`,
                    text: block.content.map(part => part.type === 'text' || part.type === 'reasoning'
                        ? part.text : `[${part.type}]`).join('\n'),
                });
                const tool = this.tools.find(tool => tool.id === block.toolCallId && tool.ended === undefined);
                if (tool !== undefined) {
                    tool.ended = event.time;
                    tool.failed = block.isError === true;
                    this.completed++;
                }
            }
            this.phase = this.tools.some(tool => tool.ended === undefined) ? '正在执行工具' : '正在整理工具结果';
            this.changed();
        }
        else if (event.type === 'step/start') {
            this.text = '';
            this.phase = `正在思考 · 第 ${event.data.step} 步`;
            this.changed();
        }
    }
    changed() {
        this.paused = this.waitingForUser;
        this.dirty = true;
        this.schedule();
    }
    /** Invalidate queued previews before a persisted assistant message or user question. */
    pause() {
        this.paused = true;
        this.epoch++;
    }
    suspend() {
        this.waitingForUser = true;
        this.pause();
    }
    resume() {
        this.waitingForUser = false;
        if (!this.disposed)
            this.changed();
    }
    dispose() {
        this.disposed = true;
        this.pause();
        clearInterval(this.timer);
        this.abort.abort();
    }
    stopByUser() {
        this.stoppedByUser = true;
        this.dispose();
    }
    /** A terminal message clears a tool-only/failed draft even without an assistant answer. */
    terminalNotice(reason) {
        if (this.stoppedByUser)
            return undefined;
        if (reason === 'completed')
            return this.paused ? undefined : '✅ **任务已完成**';
        if (reason === 'aborted' || reason === 'interrupted')
            return '⏹ **任务已中断**';
        if (reason === 'error')
            return '⚠️ **任务执行失败**，请检查 dsh 日志。';
        if (reason === 'blocked')
            return '⚠️ **任务暂时无法继续**';
        if (reason === 'max-tokens')
            return '⚠️ **输出已达到长度限制**';
        return 'ℹ️ **任务已结束**';
    }
    /** Persisted process content is folded; the latest answer remains outside. */
    finalMarkdown(text) {
        // Put trusted metadata first: an unfinished model fence must not swallow it.
        const details = this.processDetails(text);
        this.lastPublished = details ? `${details}\n\n${text}` : text;
        return this.lastPublished;
    }
    /** Include late tool results and reasoning-only turns in the terminal delivery. */
    finishMarkdown(notice) {
        if (this.stoppedByUser || this.history.length === 0)
            return undefined;
        const previous = this.lastPublished;
        const result = this.finalMarkdown(notice ?? this.latestAnswer);
        return result === previous ? undefined : result;
    }
    processDetails(answer) {
        const entries = this.history.filter((entry, index) => entry.text !== ''
            && !(answer === this.latestAnswer && this.latestTextEntries.has(index)));
        if (entries.length === 0)
            return this.details();
        // Treat recorded content as text, so literal HTML/fences cannot escape the
        // disclosure or consume the final answer. Preserve all text, including newlines.
        const body = entries.map(entry => {
            const text = escapeHtml(entry.text);
            const content = entry.title.startsWith('工具') ? `<pre>${text}</pre>` : `<p>${text.replace(/\n/g, '<br>')}</p>`;
            return `<p><b>${escapeHtml(entry.title)}</b></p>${content}`;
        }).join('');
        return `<details><summary>思考与运行记录 · 已完成 ${this.completed} 次工具调用</summary>${body}</details>`;
    }
    toolLines() {
        return this.tools.slice(-12).map(tool => {
            const seconds = Math.max(0, Math.round(((tool.ended ?? Date.now()) - tool.started) / 1000));
            return `${tool.ended === undefined ? '⏳' : tool.failed ? '❌' : '✅'} ${tool.name} · ${seconds} 秒`;
        });
    }
    details() {
        if (this.tools.length === 0)
            return '';
        return `<details><summary>运行记录 · 已完成 ${this.completed} 次工具调用</summary><p>${this.toolLines().map(escapeHtml).join('<br>')}</p></details>`;
    }
    status() {
        const active = this.tools.filter(tool => tool.ended === undefined).map(tool => tool.name).slice(0, 3);
        return `${this.phase}${active.length === 0 ? '' : `：${active.join('、')}`} · ${Math.floor((Date.now() - this.started) / 1000)} 秒`;
    }
    schedule() {
        if (this.disposed || this.paused || this.scheduled || Date.now() < this.nextSend
            || (!this.dirty && Date.now() - this.lastSent < 12000))
            return;
        this.scheduled = true;
        const epoch = this.epoch;
        void this.enqueue(async () => {
            try {
                if (this.disposed || this.paused || epoch !== this.epoch || this.signal.aborted)
                    return;
                this.dirty = false;
                await this.send();
                this.lastSent = Date.now();
                this.nextSend = Date.now() + 1200;
            }
            catch (error) {
                if (this.signal.aborted)
                    return;
                this.dirty = true;
                if (error instanceof TelegramApiError && error.code === 429) {
                    const delay = Number.isFinite(error.retryAfter) ? Math.max(1, error.retryAfter) : 5;
                    this.nextSend = Date.now() + delay * 1000;
                }
                else if (/not modified/i.test(String(error))) {
                    this.nextSend = Date.now() + 1200;
                }
                else {
                    this.nextSend = Date.now() + 5000;
                    this.warn(error);
                }
            }
            finally {
                this.scheduled = false;
            }
        });
    }
    async send() {
        const status = this.status();
        await this.client.sendRichMessageDraft(this.chatId, this.draftId, `<tg-thinking>${escapeHtml(status)}</tg-thinking>\n\n${this.details()}\n\n${this.text}`, this.signal);
    }
}
