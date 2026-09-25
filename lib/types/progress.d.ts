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
    private readonly warn;
    private readonly draftId;
    private readonly started;
    private readonly abort;
    private readonly signal;
    private readonly timer;
    private attempt;
    private revision;
    private text;
    private previewOverflow;
    private phase;
    private readonly activeTools;
    private readonly transcript;
    private lastPublished;
    private paused;
    private waitingForUser;
    private disposed;
    private stoppedByUser;
    private scheduled;
    private epoch;
    private dirty;
    private nextSend;
    private lastSent;
    constructor(client: TelegramClientLike, chatId: number, signal: AbortSignal, enqueue: (task: () => Promise<void>) => Promise<void>, warn: (error: unknown) => void);
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
    /** One rich message: folded intermediate messages followed by the answer. */
    finalMessages(text: string): string[];
    /** Include late tool results and reasoning-only turns in the terminal delivery. */
    finishMessages(notice?: string): string[] | undefined;
    private processDetails;
    private status;
    private schedule;
    private send;
}
