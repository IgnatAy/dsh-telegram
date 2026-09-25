/**
 * DSH presentation rules adapted under the MIT License.
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { homedir } from 'node:os';
import { escapeHtml } from './format.js';
export function disclosure(summary, body) {
    // A tool can legitimately finish without input/output. Do not create an
    // expand control with nothing behind it; keep its summary in the process log.
    if (!body.trim())
        return escapeHtml(summary);
    return `<details><summary>${escapeHtml(summary)}</summary>\n\n${body}\n\n</details>`;
}
/** Preserve Rich Markdown, but close unfinished fences/disclosures at each record boundary. */
export function richBody(text) {
    let fence;
    let depth = 0;
    const lines = text.split('\n').map(line => {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (marker) {
            if (!fence)
                fence = { char: marker[1][0], length: marker[1].length };
            else if (marker[1][0] === fence.char && marker[1].length >= fence.length && marker[2].trim() === '')
                fence = undefined;
            return line;
        }
        if (fence)
            return line;
        return line.replace(/<\/?details\b[^>]*>/gi, tag => {
            if (/^<\//.test(tag)) {
                if (depth === 0)
                    return escapeHtml(tag);
                depth--;
            }
            else
                depth++;
            return tag;
        });
    });
    if (fence)
        lines.push(fence.char.repeat(fence.length));
    if (depth)
        lines.push('\n' + '</details>'.repeat(depth));
    return lines.join('\n');
}
function code(text, language = '') {
    const length = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1));
    const fence = '`'.repeat(length);
    return `${fence}${language}\n${text}\n${fence}`;
}
const firstLine = (text) => text.split('\n')[0];
const isSubagent = (name) => name === 'subagent' || name.startsWith('subagent_');
function parse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// DSH tool-call-model.ts variants, plus registered search/web/todo/ask row titles.
const variants = {
    bash: 'bash', pwsh: 'bash', read: 'read', read_image: 'read', web_fetch: 'read',
    web_search: 'search', grep: 'search', glob: 'search', write: 'write', edit: 'edit',
    run_code: 'code', cordis_package_inspect: 'read', cordis_runtime_inspect: 'read',
};
const titles = {
    bash: 'Bash', pwsh: 'Pwsh', read: '读取', read_image: '读取图片', web_fetch: '网页获取',
    web_search: '网页搜索', grep: 'Grep', glob: 'Glob', write: '写入', edit: '编辑', run_code: '代码',
    cordis_package_inspect: '查看', cordis_runtime_inspect: '查看', cordis_run: '运行 Cordis 插件',
    cordis_stop: '停止 Cordis 插件', cordis_undefine: '移除 Cordis 插件',
    todo_write: '更新任务清单', ask_user_question: '提问',
};
const summaryKeys = {
    bash: ['description', 'command'], read: ['path', 'file_path', 'url'], search: ['query', 'pattern', 'url'],
    write: ['path', 'file_path'], edit: ['path', 'file_path'], code: ['description'], others: [],
};
function displayPath(text, cwd, home = homedir()) {
    const root = cwd?.replace(/[/\\]+$/, '');
    if (root && (text.startsWith(root + '/') || text.startsWith(root + '\\')))
        text = text.slice(root.length + 1);
    const base = home.replace(/\/+$/, '');
    if (base && !/^[A-Za-z]:[/\\]|^\\\\/.test(text)) {
        if (text.replace(/\/+$/, '') === base)
            return '~';
        if (text.startsWith(base + '/'))
            return '~' + text.slice(base.length);
    }
    return text;
}
export function toolSummary(tool, cwd, home) {
    const { name, arguments: raw, callId } = tool.call;
    const variant = variants[name] ?? 'others';
    const args = parse(raw);
    let summary = raw === '' ? String(callId) : firstLine(raw);
    if (record(args)) {
        const queries = variant === 'search' && Array.isArray(args.queries)
            ? args.queries.filter((value) => typeof value === 'string' && value !== '') : [];
        const picked = [...summaryKeys[variant].map(key => args[key]), ...Object.values(args)]
            .find(value => typeof value === 'string' && value !== '');
        if (queries.length)
            summary = queries.map(firstLine).join(', ');
        else if (typeof picked === 'string')
            summary = firstLine(picked);
    }
    summary = displayPath(summary, cwd, home);
    if (variant === 'others' && name !== '' && !titles[name])
        summary = `${name} · ${summary}`;
    if (name === 'todo_write' && record(args) && Array.isArray(args.todos) && args.todos.every(record)) {
        const active = args.todos.filter(todo => todo.status === 'in_progress');
        summary = `${args.todos.filter(todo => todo.status === 'completed').length}/${args.todos.length} 已完成`;
        if (typeof active[0]?.content === 'string' && active[0].content.trim()) {
            summary += ` · ${active[0].content}${active.length > 1 ? ` +${active.length - 1}` : ''}`;
        }
    }
    if (name === 'ask_user_question') {
        if (tool.error?.code === 'ASK_CANCELLED')
            summary = '已取消';
        else if (tool.error?.code === 'ASK_ABORTED')
            summary = '已中断';
        else if (tool.output === undefined)
            summary = '等待回答';
        else {
            const result = parse(tool.output);
            if (record(result) && Array.isArray(result.answers) && result.answers.every(record)) {
                const answered = result.answers.filter(answer => (Array.isArray(answer.selected) && answer.selected.length > 0)
                    || (typeof answer.custom === 'string' && answer.custom !== '')).length;
                summary = `${answered}/${result.answers.length} 已回答`;
            }
        }
    }
    else if (tool.failed && tool.error?.code !== 'interrupted' && tool.output)
        summary = firstLine(tool.output);
    const diffs = toolDiffs(tool);
    if (diffs) {
        const lines = (text) => text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
        summary += ` +${diffs.reduce((n, diff) => n + lines(diff.newText), 0)} -${diffs.reduce((n, diff) => n + lines(diff.oldText ?? ''), 0)}`;
    }
    const title = titles[name] ?? '工具调用';
    return summary ? `${title} · ${summary}` : title;
}
function toolDiffs(tool) {
    if (tool.failed || !['write', 'edit'].includes(tool.call.name))
        return undefined;
    const args = parse(tool.call.arguments);
    if (!record(args) || typeof args.file_path !== 'string' || !args.file_path.trim())
        return undefined;
    if (record(tool.meta) && Array.isArray(tool.meta.diffs) && tool.meta.diffs.length
        && tool.meta.diffs.every(diff => record(diff) && typeof diff.path === 'string'
            && (diff.oldText === null || typeof diff.oldText === 'string') && typeof diff.newText === 'string')) {
        return tool.meta.diffs;
    }
    if (tool.call.name === 'write' && typeof args.content === 'string') {
        return [{ path: args.file_path, oldText: null, newText: args.content }];
    }
    if (tool.output === undefined && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
        return [{ path: args.file_path, oldText: args.old_string || null, newText: args.new_string }];
    }
    return undefined;
}
export class TelegramTranscript {
    cwd;
    home;
    entries = [];
    calls = new Map();
    latest;
    step = 0;
    constructor(cwd, home) {
        this.cwd = cwd;
        this.home = home;
    }
    event(event) {
        if (event.type === 'step/start')
            this.step = event.data.step;
        if (event.type === 'assistant/message') {
            if (event.surfaceOp !== undefined && event.surfaceOp !== 'append')
                return;
            // Tests/older producers can omit step; keep message ordering deterministic.
            this.latest = { ...event, data: { ...event.data, step: event.data.step ?? ++this.step } };
            this.entries.push({ kind: 'assistant', event: this.latest });
        }
        else if (event.type === 'tool/call') {
            const tool = { kind: 'tool', call: event.data, counted: true };
            this.calls.set(event.data.callId, tool);
            this.entries.push(tool);
        }
        else if (event.type === 'tool/result') {
            if (event.surfaceOp !== undefined && event.surfaceOp !== 'append')
                return;
            for (const block of event.data.message.content) {
                if (block.type !== 'tool-result')
                    continue;
                let tool = this.calls.get(block.toolCallId);
                if (!tool) {
                    tool = { kind: 'tool', call: { turn: event.data.turn, step: event.data.step,
                            callId: block.toolCallId, name: '', arguments: '' }, counted: false };
                    this.calls.set(block.toolCallId, tool);
                    this.entries.push(tool);
                }
                tool.output = block.content.map(part => part.type === 'text' ? part.text : code(JSON.stringify(part, null, 2), 'json')).join('\n')
                    || (event.data.error ? `${event.data.error.name}: ${event.data.error.code}` : '');
                tool.meta = event.data.meta;
                tool.error = event.data.error;
                tool.failed = block.isError === true;
            }
        }
    }
    get answer() {
        return this.latest?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? '';
    }
    get hasEntries() { return this.entries.length > 0; }
    render(answer) {
        const final = answer === this.answer && this.answer.trim() !== ''
            && (this.latest?.data.step ?? 0) >= this.step
            && !this.latest?.data.message.content.some(block => block.type === 'tool-call') ? this.latest : undefined;
        let messages = 0;
        let tools = 0;
        let subagents = 0;
        const body = [];
        for (const entry of this.entries) {
            if (entry.kind === 'tool') {
                if (entry.counted) {
                    if (isSubagent(entry.call.name))
                        subagents++;
                    else
                        tools++;
                }
                // Keep only the row summary; large inputs/results stay in DSH history.
                body.push(escapeHtml(toolSummary(entry, this.cwd, this.home)));
                continue;
            }
            const { event } = entry;
            const content = event.data.message.content;
            const beforeAnswer = final === undefined || event.data.step < final.data.step;
            if (beforeAnswer && content.some(block => block.type === 'text' && block.text.trim() !== ''))
                messages++;
            for (const block of content) {
                if (block.type === 'reasoning' && block.text.trim()) {
                    const summary = firstLine(block.text).replaceAll('**', '');
                    body.push(escapeHtml(`思考 · ${summary}`));
                }
                else if (block.type === 'text' && block.text.trim() && event !== final) {
                    body.push(richBody(block.text));
                }
            }
        }
        if (body.length === 0)
            return '';
        const labels = [tools > 0 ? `${tools} 次工具调用` : '', messages > 0 ? `${messages} 条消息` : '',
            subagents > 0 ? `${subagents} 个 subagent` : ''].filter(Boolean);
        return disclosure(labels.join(' · ') || '已思考', body.join('\n\n'));
    }
}
