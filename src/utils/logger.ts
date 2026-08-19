import type { BookingState, LogEntry, TimelineMark } from '@/types';
import { formatBst, nowPerf, serverNow } from './timing';

/**
 * Diagnostic log with two hard rules:
 *
 *  1. Nothing sensitive is ever written. A redaction pass runs on every message before it
 *     is stored, so a future caller cannot leak a secret by accident.
 *  2. No storage writes on the critical path. Entries land in a preallocated ring buffer in
 *     memory and are flushed only when the run is over or the popup asks.
 */

const RING_CAPACITY = 512;

/** Patterns that must never reach the log, regardless of what a caller passes in. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b\d{6}\b(?=\s*(otp|code|pin))/gi, '«redacted»'],
  [/\b(otp|pin|cvv|cvc)\b\s*[:=]?\s*\S+/gi, '$1 «redacted»'],
  [/\b(?:\d[ -]?){13,19}\b/g, '«redacted-card»'],
  // The optional scheme word matters: without it, "Authorization: Bearer <token>" would
  // consume only the word "Bearer" and leave the token itself in the log.
  [
    /\b(pass(?:word)?|passwd|secret|token|authorization|auth[_-]?key|api[_-]?key)\b\s*[:=]?\s*(?:(?:bearer|basic)\s+)?\S+/gi,
    '$1 «redacted»',
  ],
  [/\b(bearer|basic)\s+[\w.\-+/=]{8,}/gi, '$1 «redacted»'],
  [/\bg-recaptcha-response\b\s*[:=]?\s*\S+/gi, 'g-recaptcha-response «redacted»'],
  // Bangladeshi NID: 10, 13 or 17 digits. Never logged.
  [/\b(\d{17}|\d{13}|\d{10})\b/g, '«redacted-id»'],
];

export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export type LogListener = (entry: LogEntry) => void;

class Logger {
  private ring: Array<LogEntry | undefined> = new Array(RING_CAPACITY);
  private writeIndex = 0;
  private wrapped = false;
  private listeners = new Set<LogListener>();
  private timeline: TimelineMark[] = [];
  /** While true, listeners are not notified - keeps the critical path free of UI work. */
  private quiet = false;

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
  }

  onEntry(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private push(level: LogEntry['level'], message: string, detail?: string): void {
    const entry: LogEntry = {
      wall: formatBst(serverNow()),
      perf: Number(nowPerf().toFixed(3)),
      level,
      message: redact(message),
      ...(detail ? { detail: redact(detail) } : {}),
    };

    this.ring[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % RING_CAPACITY;
    if (this.writeIndex === 0) this.wrapped = true;

    if (!this.quiet) {
      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          /* a broken listener must never break the run */
        }
      }
    }
  }

  info(message: string, detail?: string): void {
    this.push('info', message, detail);
  }
  warn(message: string, detail?: string): void {
    this.push('warn', message, detail);
  }
  error(message: string, detail?: string): void {
    this.push('error', message, detail);
  }

  /** Record a measured stage boundary. The value is real, never estimated. */
  timing(label: string, state: BookingState): void {
    const perf = Number(nowPerf().toFixed(3));
    this.timeline.push({ label, perf, state });
    this.push('timing', `${label} @ ${perf.toFixed(3)}ms`);
  }

  entries(): LogEntry[] {
    if (!this.wrapped) {
      return this.ring.slice(0, this.writeIndex).filter(Boolean) as LogEntry[];
    }
    const tail = this.ring.slice(this.writeIndex).filter(Boolean) as LogEntry[];
    const head = this.ring.slice(0, this.writeIndex).filter(Boolean) as LogEntry[];
    return [...tail, ...head];
  }

  /** Stage-to-stage deltas, computed from the measured marks. */
  timelineReport(): Array<{ label: string; state: BookingState; atMs: number; deltaMs: number }> {
    let prev: number | null = null;
    return this.timeline.map((m) => {
      const row = {
        label: m.label,
        state: m.state,
        atMs: Number(m.perf.toFixed(3)),
        deltaMs: prev === null ? 0 : Number((m.perf - prev).toFixed(3)),
      };
      prev = m.perf;
      return row;
    });
  }

  clear(): void {
    this.ring = new Array(RING_CAPACITY);
    this.writeIndex = 0;
    this.wrapped = false;
    this.timeline = [];
  }
}

export const logger = new Logger();
