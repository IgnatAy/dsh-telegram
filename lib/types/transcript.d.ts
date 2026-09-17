import type { SessionEvent } from '@deepseek-ai/dsh-session';
type Call = Extract<SessionEvent, {
    type: 'tool/call';
}>['data'];
interface ToolEntry {
    kind: 'tool';
    call: Call;
    output?: string;
    error?: {
        name: string;
        code: string;
    };
    failed?: boolean;
    counted: boolean;
    meta?: unknown;
}
export declare function disclosure(summary: string, body: string): string;
/** Preserve Rich Markdown, but close unfinished fences/disclosures at each record boundary. */
export declare function richBody(text: string): string;
export declare function toolSummary(tool: ToolEntry, cwd?: string, home?: string): string;
export declare class TelegramTranscript {
    private readonly cwd?;
    private readonly home?;
    private readonly entries;
    private readonly calls;
    private latest?;
    private step;
    constructor(cwd?: string | undefined, home?: string | undefined);
    event(event: SessionEvent): void;
    get answer(): string;
    get hasEntries(): boolean;
    render(answer: string): string;
}
export {};
