/** One replaceable complete output per bot/chat; retained for display recovery. */
export declare class TelegramResultCache {
    private readonly queues;
    readonly directory: string;
    constructor(token: string, directory?: string);
    private exclusive;
    private path;
    deliver<T>(chatId: number, markdown: string | string[], send: (text: string) => Promise<T>): Promise<void>;
    resend(chatId: number, send: (text: string) => Promise<unknown>): Promise<boolean>;
}
