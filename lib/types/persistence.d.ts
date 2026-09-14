import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
/** Public concrete JSONL capability; the abstract rc2 persistence service has no locator. */
interface JsonlPersistence extends SessionPersistence {
    resolveCurrentLog(id: SessionId, signal?: AbortSignal): Promise<string | undefined>;
}
export declare function requireJsonlPersistence(storage: SessionPersistence): JsonlPersistence;
/**
 * Delete all committed generations with rc2 write ownership held. Keep session.lock:
 * unlinking that inode would let another process bypass the kernel lock.
 * Move logs aside before detaching, restoring them if staging or detachment fails.
 */
export declare function deleteSessionLogs(storage: JsonlPersistence, id: SessionId, detach: () => Promise<void>, signal: AbortSignal): Promise<void>;
export {};
