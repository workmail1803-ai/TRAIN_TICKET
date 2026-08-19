/**
 * Clock discipline and the T0 countdown.
 *
 * Two different clocks, never mixed:
 *   performance.now()  -> all internal measurement. Monotonic, sub-millisecond.
 *   Date.now()         -> wall-clock scheduling only, and only after offset correction.
 */

export const BST_TIMEZONE = 'Asia/Dhaka';

export function nowPerf(): number {
  return performance.now();
}

/** Milliseconds to add to Date.now() to approximate server time. Set by syncServerClock(). */
let serverOffsetMs = 0;
let serverOffsetConfidenceMs = Number.POSITIVE_INFINITY;

export function getServerOffsetMs(): number {
  return serverOffsetMs;
}

export function getServerOffsetConfidenceMs(): number {
  return serverOffsetConfidenceMs;
}

/** Best estimate of the server's current wall clock. */
export function serverNow(): number {
  return Date.now() + serverOffsetMs;
}

// ---------------------------------------------------------------------------
// Timezone arithmetic that does NOT trust the machine's timezone
// ---------------------------------------------------------------------------

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BST_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function zonedParts(epochMs: number): ZonedParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  // Intl can emit hour "24" for midnight in some locales/engines.
  const hour = Number(map.hour) % 24;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Offset of Asia/Dhaka from UTC at a given instant, in ms. Derived, never hard-coded. */
function zoneOffsetMs(epochMs: number): number {
  const p = zonedParts(epochMs);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // epochMs carries sub-second precision the formatter discarded; drop it on both sides.
  return asIfUTC - Math.floor(epochMs / 1000) * 1000;
}

/** Convert a wall-clock time *in Asia/Dhaka* to an epoch timestamp. */
export function bstWallToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const asIfUTC = Date.UTC(year, month - 1, day, hour, minute, second);
  // One refinement pass. Dhaka has no DST, but this keeps the maths correct regardless.
  let epoch = asIfUTC - zoneOffsetMs(asIfUTC);
  epoch = asIfUTC - zoneOffsetMs(epoch);
  return epoch;
}

/** Parse "HH:mm:ss" or "HH:mm". Throws on anything else rather than guessing. */
export function parseClockTime(value: string): { hour: number; minute: number; second: number } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time "${value}" - expected HH:mm or HH:mm:ss`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`Time out of range: "${value}"`);
  return { hour, minute, second };
}

/**
 * Next occurrence of a Bangladesh wall-clock time, as an epoch timestamp.
 * Correct regardless of the machine's own timezone.
 */
export function nextBstOccurrence(clock: string, fromEpochMs = serverNow()): number {
  const { hour, minute, second } = parseClockTime(clock);
  const today = zonedParts(fromEpochMs);
  let target = bstWallToEpoch(today.year, today.month, today.day, hour, minute, second);
  if (target <= fromEpochMs) {
    // Advance one Dhaka calendar day, then recompute from the resulting date's parts.
    const tomorrow = zonedParts(target + 24 * 60 * 60 * 1000);
    target = bstWallToEpoch(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, second);
  }
  return target;
}

export function formatBst(epochMs: number): string {
  const p = zonedParts(epochMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const ms = Math.abs(epochMs % 1000);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(ms, 3)}`
  );
}

// ---------------------------------------------------------------------------
// Server clock sync
// ---------------------------------------------------------------------------

/**
 * Estimate the server's clock from the HTTP `Date` response header, NTP-style: take a few
 * samples and keep the one with the lowest round-trip, since that sample has the least
 * ambiguity about when the server actually stamped it.
 *
 * The header has 1-second resolution, so the honest accuracy here is roughly +/- 500 ms.
 * Nothing in this codebase claims better.
 *
 * Cost: `samples` requests spread over the arming window. Negligible, and never repeated
 * inside the critical window.
 */
export async function syncServerClock(url: string, samples = 3): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: serverOffsetMs };

  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    } catch {
      continue;
    }
    const t1 = Date.now();
    const header = res.headers.get('date');
    if (!header) continue;

    const serverMs = Date.parse(header);
    if (Number.isNaN(serverMs)) continue;

    const rtt = t1 - t0;
    // Assume the stamp was written at the midpoint of the round trip, and that the
    // truncated second is on average half a second behind.
    const localAtStamp = t0 + rtt / 2;
    const offset = serverMs + 500 - localAtStamp;

    if (rtt < best.rtt) best = { rtt, offset };

    if (i < samples - 1) await delayMs(150);
  }

  if (Number.isFinite(best.rtt)) {
    serverOffsetMs = Math.round(best.offset);
    serverOffsetConfidenceMs = Math.round(500 + best.rtt / 2);
  }
  return serverOffsetMs;
}

/** The only sleep in the codebase. Used for spacing clock samples, never for sequencing UI. */
function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pin the server's second boundary, which is what actually limits our accuracy.
 *
 * The `Date` header only has 1-second resolution, so a single reading can never be better than
 * about +/- 500 ms - and that error is the floor on "fire exactly at 08:00:00". This narrows it
 * by polling until the header's second CHANGES. That tick happened somewhere between the
 * previous response and this one, so the midpoint of that window is a direct measurement of the
 * boundary, accurate to roughly half the sampling window rather than half a second.
 *
 * Bounded and modest: HEAD requests at `intervalMs` for at most `maxMs`, run twice per booking
 * (at ARM and near the window). It stops the instant it sees the tick.
 */
export async function refineServerClock(
  url: string,
  maxMs = 2500,
  intervalMs = 120
): Promise<number> {
  let previousSecond: number | null = null;
  let previousSent = 0;
  let previousReceived = 0;
  const started = Date.now();

  while (Date.now() - started < maxMs) {
    const sent = Date.now();
    let response: Response;
    try {
      response = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    } catch {
      await delayMs(intervalMs);
      continue;
    }
    const received = Date.now();

    const header = response.headers.get('date');
    if (!header) return serverOffsetMs;

    const serverMs = Date.parse(header);
    if (Number.isNaN(serverMs)) return serverOffsetMs;

    if (previousSecond !== null && serverMs > previousSecond) {
      // The tick fell between the previous response and this one. Midpoint is our estimate of
      // the local instant at which the server's clock read exactly `serverMs`.
      const boundaryLocal = (previousReceived + received) / 2;
      serverOffsetMs = Math.round(serverMs - boundaryLocal);
      // Honest bound: the stamp could have been written anywhere from the previous request
      // being sent to this response arriving.
      serverOffsetConfidenceMs = Math.round((received - previousSent) / 2);
      return serverOffsetMs;
    }

    previousSecond = serverMs;
    previousSent = sent;
    previousReceived = received;
    await delayMs(intervalMs);
  }

  return serverOffsetMs;
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

export interface CountdownHandle {
  cancel(): void;
}

/**
 * Fire once at `targetEpochMs`, using a self-correcting chain rather than one long timer.
 *
 * A single multi-minute setTimeout drifts and gets throttled. Each hop below recomputes the
 * remaining time from the corrected clock, so error cannot accumulate:
 *
 *   > 60s   coarse timer, re-evaluated on each fire
 *   > 2s    one more coarse hop
 *   > 50ms  short chained timers
 *   <= 50ms requestAnimationFrame gate, fires on the first frame at or past target
 *
 * Note: background tabs are throttled by Chrome. The caller must keep the tab foreground,
 * and the popup tells the user so.
 */
/** Length of the final busy-wait, in milliseconds. */
const SPIN_WINDOW_MS = 4;

export function scheduleAt(targetEpochMs: number, onFire: () => void): CountdownHandle {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const step = () => {
    if (cancelled) return;
    const remaining = targetEpochMs - serverNow();

    if (remaining <= SPIN_WINDOW_MS) {
      /**
       * Final approach: busy-wait, not a timer and not requestAnimationFrame.
       *
       * setTimeout cannot resolve finer than a few milliseconds and is explicitly allowed to
       * fire late. requestAnimationFrame is worse for this - it fires on the next frame, so it
       * can land up to ~16 ms after the target. A short spin on the monotonic clock is what
       * actually buys sub-millisecond accuracy, and 4 ms of blocking costs nothing.
       *
       * The deadline is converted to performance.now() once, so the spin itself does not keep
       * re-reading a coarser wall clock.
       */
      const deadline = performance.now() + Math.max(0, remaining);
      while (performance.now() < deadline) {
        /* spin */
      }
      onFire();
      return;
    }

    const wait =
      remaining > 60_000
        ? remaining - 60_000
        : remaining > 2_000
          ? remaining - 2_000
          : remaining - SPIN_WINDOW_MS;

    timer = setTimeout(step, Math.max(1, wait));
  };

  step();

  return {
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export class Stopwatch {
  private readonly startPerf = nowPerf();
  private marks: Array<{ label: string; perf: number }> = [];

  mark(label: string): number {
    const perf = nowPerf();
    this.marks.push({ label, perf });
    return perf - this.startPerf;
  }

  elapsed(): number {
    return nowPerf() - this.startPerf;
  }

  /** Measured deltas between consecutive marks. Never estimated. */
  report(): Array<{ label: string; sinceStartMs: number; sincePrevMs: number }> {
    let prev = this.startPerf;
    return this.marks.map((m) => {
      const row = {
        label: m.label,
        sinceStartMs: Number((m.perf - this.startPerf).toFixed(3)),
        sincePrevMs: Number((m.perf - prev).toFixed(3)),
      };
      prev = m.perf;
      return row;
    });
  }

  reset(): void {
    this.marks = [];
  }
}
