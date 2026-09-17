import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { TelegramClientLike } from './client.js';
/**
 * One turn's disposable preview. Events mutate bounded state synchronously; a
 * coalescer sends only the latest snapshot through the bridge's delivery queue.
 * No tool arguments or result bodies are copied into the preview.
 */
export declare class TelegramProgress {
    private readonly client;
    private readonly chatId;
    private readonly enqueue;
    private readonly track;
    private readonly warn;
    private readonly maxLength;
    readonly draftId: number;
    private readonly started;
    private readonly abort;
    private readonly signal;
    private readonly timer;
    private attempt;
    private revision;
    private text;
    private phase;
    private tools;
    private completed;
    private paused;
    private waitingForUser;
    private disposed;
    private stoppedByUser;
    private scheduled;
    private epoch;
    private dirty;
    private nextSend;
    private lastSent;
    private fallbackMessage;
    private mode;
    constructor(client: TelegramClientLike, chatId: number, signal: AbortSignal, enqueue: (task: () => Promise<void>) => Promise<void>, track: (messageId: number) => void, warn: (error: unknown) => void, maxLength?: number);
    /** Reject old attempts and revisions, including late chunks after a retry. */
    stream(frame: AssistantStreamFrame): void;
    event(event: SessionEvent): void;
    private changed;
    /** Invalidate queued previews before a persisted assistant message or user question. */
    pause(): void;
    suspend(): void;
    resume(): void;
    dispose(): void;
    stopByUser(): void;
    /** A terminal message clears a tool-only/failed draft even without an assistant answer. */
    terminalNotice(reason: string): string | undefined;
    /** Native stops must match this live draft, not a previous turn or another topic. */
    acceptsStop(draftId: number): boolean;
    /** Rich final content keeps recent tool outcomes in a collapsed section. */
    finalHtml(text: string): string | undefined;
    private toolLines;
    private details;
    private status;
    private schedule;
    private send;
}
