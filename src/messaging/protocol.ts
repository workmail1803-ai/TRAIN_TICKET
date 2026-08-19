import type { BookingResult, BookingState, LogEntry, ValidationIssue } from '@/types';

/**
 * One typed channel. No stringly-typed action names, so a rename is a compile error rather
 * than a silent no-op at 08:00.
 */

export type PopupToContent =
  | { type: 'ARM' }
  | { type: 'DISARM' }
  | { type: 'STOP'; reason: string }
  | { type: 'CONTINUE_AFTER_USER' }
  | { type: 'REQUEST_SNAPSHOT' }
  /** Skip the countdown and run the booking flow immediately. */
  | { type: 'RUN_NOW' };

export type ContentToPopup =
  | { type: 'SNAPSHOT'; payload: EngineSnapshot }
  | { type: 'STATE_CHANGED'; state: BookingState; detail: string }
  | { type: 'LOG'; entry: LogEntry }
  | { type: 'VALIDATION_FAILED'; issues: ValidationIssue[] }
  | { type: 'RESULT'; result: BookingResult };

export type AnyMessage = PopupToContent | ContentToPopup;

export interface EngineSnapshot {
  state: BookingState;
  detail: string;
  armed: boolean;
  loggedIn: boolean;
  page: string;
  /** Epoch ms of the next booking-open moment, or null when not armed. */
  targetEpochMs: number | null;
  serverOffsetMs: number;
  serverOffsetConfidenceMs: number;
  confirmedSeats: string[];
  targetSeats: number;
  elapsedMs: number;
  awaitingUserReason: string | null;
  /** True when the tab is backgrounded, where Chrome throttles the countdown. */
  tabHidden: boolean;
  issues: ValidationIssue[];
  timeline: Array<{ label: string; state: BookingState; atMs: number; deltaMs: number }>;
}

/** Send to the content script in the active railway tab. Resolves null if nothing is there. */
export async function sendToContent<T = unknown>(
  tabId: number,
  message: PopupToContent
): Promise<T | null> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch {
    // No content script on this tab - expected when the user is on another page.
    return null;
  }
}

export function sendToPopup(message: ContentToPopup): void {
  // The popup is often closed; a rejected send is normal and must not break the run.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}
