import { AbortedError } from './wait';

export interface RetryOptions {
  what: string;
  attempts: number;
  /** Delay between attempts. Kept small; this is recovery, not pacing. */
  gapMs?: number;
  signal?: AbortSignal;
  onAttemptFailed?: (attempt: number, error: Error) => void;
  /** Return false to stop retrying immediately (e.g. the failure is not transient). */
  shouldRetry?: (error: Error) => boolean;
}

/**
 * Bounded retry. Deliberately not exponential: at 08:00 a long backoff is worse than a
 * clean failure, because the state machine has cheaper fallbacks (next class, next train)
 * than waiting on a step that is already failing.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { what, attempts, gapMs = 0, signal, onAttemptFailed, shouldRetry } = options;
  let lastError: Error = new Error(`No attempts made for: ${what}`);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new AbortedError(what);
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError instanceof AbortedError) throw lastError;
      onAttemptFailed?.(attempt, lastError);
      if (shouldRetry && !shouldRetry(lastError)) break;
      if (attempt < attempts && gapMs > 0) {
        await new Promise((r) => setTimeout(r, gapMs));
      }
    }
  }
  throw lastError;
}

/** Run `fn`, returning null instead of throwing. For genuinely optional steps only. */
export async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
