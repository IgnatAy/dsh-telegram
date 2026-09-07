/**
 * Telegram→harness bridge: owns the long-polling loop, per-chat agent
 * sessions, slash commands, and delivery of assistant output back to
 * Telegram. The design mirrors Hermes' telegram platform adapter (per-chat
 * sessions, allowlist, HTML formatting, 4096-char splitting, typing
 * indicator), trimmed to the harness's text-first seams.
 * @module telegram/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TelegramClientLike } from './client.js';
/** Reasoning levels accepted by the plugin's static configuration schema. */
export type TelegramReasoningEffort = 'off' | 'low' | 'high' | 'max';
/** Options for {@link TelegramBridge}. */
export interface TelegramBridgeOptions {
    /** Bot token from @BotFather. */
    token: string;
    /** User ids allowed to talk to the bot; empty means none unless `allowAllUsers`. */
    allowedUserIds?: number[];
    /** Allow any Telegram user (development only). */
    allowAllUsers?: boolean;
    /** LLM provider id passed to each created agent. */
    provider?: string;
    /** Model id passed to each created agent. */
    model?: string;
    /** Per-chunk message length limit (Telegram caps at 4096). */
    maxMessageLength?: number;
    /** Long-polling timeout in seconds. */
    pollingTimeoutSec?: number;
    /** Agent preset id mounted on each created agent (requires `agent-presets`). */
    preset?: string;
    /** Default reasoning effort (off|low|high|max); `/reasoning` overrides per chat. */
    reasoningEffort?: TelegramReasoningEffort | '';
    /** Client seam; tests substitute a fake. */
    client?: TelegramClientLike;
    /** Delay seam; tests substitute an instant sleep. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
/**
 * Bridge between Telegram chats and harness agent sessions. One agent
 * session per chat; incoming text becomes a user message via `followup`,
 * and assistant messages are delivered back as (split, HTML-formatted)
 * Telegram messages. Lifecycle: {@link TelegramBridge.start} begins polling;
 * {@link TelegramBridge.stop} releases Telegram bindings and only the Agent
 * handles that this bridge created or resumed itself.
 */
export declare class TelegramBridge {
    private readonly ctx;
    private readonly client;
    private readonly allowedUserIds;
    private readonly allowAllUsers;
    private readonly provider;
    private readonly model;
    private readonly maxMessageLength;
    private readonly sleep;
    /** Agent preset id mounted on each created agent; undefined leaves the composition default. */
    private readonly preset;
    /** Default reasoning effort; undefined leaves the adapter default. */
    private readonly defaultEffort;
    private readonly chats;
    private readonly chatsBySession;
    /** Handles owned by Telegram stay live across `/use` switches. */
    private readonly ownedAgents;
    /** Explicit `/collect` drafts keyed by Telegram private-chat id. */
    private readonly collections;
    /** Human-input requests keyed by Telegram chat id; at most one per chat. */
    private readonly pendingQuestions;
    private readonly abortController;
    private offset;
    private stopped;
    private errorCount;
    private disposeEvents;
    private pollTask;
    private commandTask;
    private stopTask;
    /**
     * @param ctx - Cordis context providing `agents` (declared by the plugin's
     * `inject`) and the session/event stream.
     * @param options - bridge options.
     */
    constructor(ctx: Context, options: TelegramBridgeOptions);
    /** Register the session listener, publish the command list, and start polling. */
    start(): void;
    /** Publish the slash-command list so Telegram's `/` menu matches the bot. */
    private registerCommands;
    /** Stop polling, unregister Telegram bindings, and dispose bridge-owned Agents. */
    stop(): Promise<void>;
    /** Perform the single lifecycle teardown shared by all `stop()` callers. */
    private stopImpl;
    private pollLoop;
    /** Wait for the poll cadence/backoff, but release immediately during teardown. */
    private wait;
    private handleUpdate;
    private authorizedUser;
    private handleCommand;
    /** Return only a draft that still belongs to the exact active session. */
    private collectionFor;
    /** Summarize an in-progress collection without exposing internal attachment ids. */
    private collectionStatus;
    /** Telegram documents are admitted only when their declaration plausibly names a supported raster. */
    private imageDocument;
    /** Extract one full-resolution download candidate from a Telegram message. */
    private imageCandidate;
    /** Explain the native DSH attachment boundary instead of silently dropping a document. */
    private unsupportedDocument;
    /** Explicit `/followup`: submit one message, or submit the active collection as a later turn. */
    private handleFollowupMessage;
    /** Add one Telegram message and its reply context to an explicit collection. */
    private addToCollection;
    /** Submit and clear one collection only after DSH has accepted it. */
    private submitCollection;
    /** Build and submit one ordinary Telegram message. */
    private submitTelegramMessage;
    /**
     * Preserve Telegram reply semantics inside the same DSH user message. Quoted
     * text is explicitly delimited, and quoted images remain adjacent to that
     * delimiter, so no context can leak into a different turn.
     */
    private telegramMessageParts;
    /** Download, verify, and save one image beneath the selected workspace. */
    private downloadWorkspaceImage;
    /** Create an exclusive file under `<workspace>/telegram-downloads` without following an escaping directory link. */
    private saveWorkspaceFile;
    /** Admit collected rasters, preserve their order, then choose steer vs. follow-up. */
    private submitParts;
    /** Return a chat state without selecting a workspace or creating an Agent. */
    private stateFor;
    /** Read the adapter-owned model catalog and retain the current route if it is unlisted. */
    private loadModelCatalog;
    /** Render one flat numbered model selector across provider groups. */
    private formatModelCatalog;
    /** Resolve exact metadata for the model currently selected by one chat. */
    private resolveCurrentModel;
    /** Resolve display metadata without preventing unrelated selectors from rendering. */
    private currentModelInfoOrUndefined;
    /** Apply one route to chat-owned selection or the official selection of a borrowed Agent. */
    private applyChatSelection;
    /** Render the complete per-chat selection shown before every no-argument selector. */
    private formatSelectionSummary;
    /** Build the default option plus the exact effort ids exposed by the selected model. */
    private reasoningChoices;
    /** Render the exact reasoning choices validated by the selected model adapter. */
    private formatReasoningChoices;
    /** Build the current numbered workspace/session catalog. */
    private loadCatalog;
    /** Attach only historical Telegram sessions that predate workspace integration. */
    private repairTelegramMembership;
    /** Render one stable numbered catalog for `/use`. */
    private formatCatalog;
    /** Resolve one numbered selection and bind the Telegram chat to it. */
    private useCatalogSelection;
    /** Create, attach, and bind a new session in an existing workspace. */
    private createAndBind;
    /** Reuse a global live Agent or resume one Agent owned by this bridge. */
    private resolveAgentForUse;
    /** Validate ownership and apply this chat's model route to a borrowed live Agent. */
    private prepareLiveAgent;
    /** Initialize delivery bookkeeping and Telegram-only bindings for one Agent. */
    private activeSession;
    /** Publish a replacement binding only after the previous Agent is quiescent. */
    private bind;
    /** Forget the Telegram binding while leaving the global Agent lifecycle intact. */
    private releaseActive;
    /** Delete the current durable JSONL log and detach it from its workspace. */
    private clearCurrent;
    /**
     * Agent setup hook: mount the preset and install the per-chat model route.
     * Telegram-only channel and question listeners are attached by `bind()` so
     * switching sessions can remove them without destroying the Agent.
     */
    private makeSetup;
    /** Attach the channel prompt and question transport for one current chat binding. */
    private attachTelegramBinding;
    /** Claim one DSH user-question request for the currently bound Telegram chat. */
    private askThroughTelegram;
    /** Handle one inline-keyboard choice and always dismiss Telegram's callback spinner. */
    private handleCallbackQuery;
    /** Send the current item, attaching buttons or a Telegram ForceReply composer. */
    private presentQuestion;
    /** Render a question with all details visible even when button labels must be shortened. */
    private formatQuestion;
    /** Build the current keyboard; multi-select choices show their checked state. */
    private questionKeyboard;
    private questionCallbackData;
    /** Keep button text readable without risking an oversized keyboard label. */
    private buttonLabel;
    /** Enter free-text mode after a user explicitly presses the custom-answer button. */
    private requestCustomAnswer;
    /** Store one answer and either present the next question or resume the Agent. */
    private submitQuestionAnswer;
    private currentQuestion;
    /** Abort question delivery when either the bridge or the DSH request ends. */
    private questionSignal;
    private selectedLabels;
    /** Update checkmarks after toggling a multi-select option. */
    private refreshQuestionKeyboard;
    /** Remove an old keyboard so it cannot submit an answer twice. */
    private clearQuestionKeyboard;
    private resolvePendingQuestion;
    private rejectPendingQuestion;
    /** Atomically remove a pending request and its abort listener. */
    private settlePendingQuestion;
    /** Callback acknowledgements are best-effort but never omitted. */
    private safeAnswerCallback;
    private handleSessionEvent;
    /** Serialize per-chat session-event side effects; never lets them interleave. */
    private enqueue;
    /** Turn start: remove artifacts from an unbalanced previous turn, then show typing. */
    private onTurnStart;
    /** Send each complete assistant step as a fresh message instead of editing prior output. */
    private onAssistantText;
    /**
     * Turn finished: the latest assistant step is already visible as the final
     * answer, so remove every prior output and interaction artifact. An aborted
     * turn has no final answer and removes the latest partial output too.
     */
    private onTurnEnd;
    /** Add a bot or user interaction message to the current turn's cleanup set. */
    private trackTransientMessage;
    /** Delete turn artifacts, optionally including the latest partial/final assistant step. */
    private cleanupTurnMessages;
    /** Delete in Bot API batches, falling back to single-message deletion for compatibility. */
    private deleteMessageIds;
    /** Keep Telegram's typing indicator alive while a turn runs (the action expires after ~5s). */
    private startTyping;
    /** Stop the typing heartbeat for a chat. */
    private stopTyping;
    private chatFor;
    private deliver;
    /** Send a message; HTML failures fall back to plain text (Telegram rejects malformed entities). */
    private safeSend;
    private safeAction;
}
