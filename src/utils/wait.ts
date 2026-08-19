/**
 * Event-driven waiting. There is no blind sleep anywhere in this file, and no polling
 * loop that is not explicitly opted into as a last resort.
 */

export class WaitTimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly timeoutMs: number
  ) {
    super(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
    this.name = 'WaitTimeoutError';
  }
}

export class AbortedError extends Error {
  constructor(readonly what: string) {
    super(`Aborted while waiting for: ${what}`);
    this.name = 'AbortedError';
  }
}

export interface WaitOptions {
  /** Human-readable description, used in errors and logs. */
  what: string;
  timeoutMs: number;
  /**
   * Container to observe. MUST be as narrow as possible.
   *
   * This site renders live counters ("N users are trying to book", "Total Active Users on
   * this page") that mutate continuously on their own. Observing `document` with
   * subtree:true would fire this callback nonstop and burn CPU during the exact window
   * that matters. Always scope to the smallest container that can contain the change.
   */
  scope?: Node;
  signal?: AbortSignal;
  /**
   * Safety net for changes MutationObserver cannot see - a value set by a framework
   * without touching attributes, a CSS-only enable, an :disabled transition. Off by default.
   */
  pollMs?: number;
}

/**
 * Resolve as soon as `predicate` returns a non-null, non-false value.
 *
 * Evaluates immediately first, so an already-satisfied condition costs one call and
 * never sets up an observer at all.
 */
export function waitFor<T>(
  predicate: () => T | null | undefined | false,
  options: WaitOptions
): Promise<T> {
  const { what, timeoutMs, scope, signal, pollMs } = options;

  return new Promise<T>((resolve, reject) => {
    // Fast path: already true.
    const immediate = predicate();
    if (immediate !== null && immediate !== undefined && immediate !== false) {
      resolve(immediate);
      return;
    }

    if (signal?.aborted) {
      reject(new AbortedError(what));
      return;
    }

    let done = false;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      done = true;
      observer?.disconnect();
      observer = null;
      if (timer !== null) clearTimeout(timer);
      if (poll !== null) clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
    };

    const attempt = () => {
      if (done) return;
      let value: T | null | undefined | false;
      try {
        value = predicate();
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (value !== null && value !== undefined && value !== false) {
        cleanup();
        resolve(value);
      }
    };

    function onAbort() {
      if (done) return;
      cleanup();
      reject(new AbortedError(what));
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    const target = scope ?? document.body ?? document.documentElement;
    if (target) {
      observer = new MutationObserver(attempt);
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }

    if (pollMs && pollMs > 0) poll = setInterval(attempt, pollMs);

    timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new WaitTimeoutError(what, timeoutMs));
    }, timeoutMs);
  });
}

/** Race several waits; the first to resolve wins and the rest are aborted. */
export async function waitForFirst<T>(
  entries: Array<{ label: string; run: (signal: AbortSignal) => Promise<T> }>,
  signal?: AbortSignal
): Promise<{ label: string; value: T }> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await Promise.race(
      entries.map(async (e) => ({ label: e.label, value: await e.run(controller.signal) }))
    );
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Wait for the next animation frame. Used to let a render settle before re-reading. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Wait for a burst of mutations to stop. Used only where the site genuinely re-renders a
 * whole region (switching coach re-draws the entire seat grid) and there is no single
 * element whose appearance means "done".
 */
export function waitForQuiet(
  scope: Node,
  quietMs: number,
  options: { what: string; timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settle: ReturnType<typeof setTimeout>;
    let done = false;

    const cleanup = () => {
      done = true;
      observer.disconnect();
      clearTimeout(settle);
      clearTimeout(hard);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (done) return;
      cleanup();
      resolve();
    };
    const bump = () => {
      clearTimeout(settle);
      settle = setTimeout(finish, quietMs);
    };
    function onAbort() {
      if (done) return;
      cleanup();
      reject(new AbortedError(options.what));
    }

    const observer = new MutationObserver(bump);
    observer.observe(scope, { childList: true, subtree: true, attributes: true });
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const hard = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new WaitTimeoutError(options.what, options.timeoutMs));
    }, options.timeoutMs);

    bump();
  });
}
