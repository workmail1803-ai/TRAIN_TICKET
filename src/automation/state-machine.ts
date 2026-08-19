import type { BookingState } from '@/types';
import { HUMAN_STATES, TERMINAL_STATES } from '@/types';
import { logger } from '@/utils/logger';
import { nowPerf } from '@/utils/timing';

/**
 * Explicit state machine.
 *
 * Transitions are declared, not implied. An undeclared transition throws rather than
 * proceeding, which is the whole point: the engine must never drift into a state it did not
 * intend to be in and start clicking.
 */

/** From -> allowed next states. */
const TRANSITIONS: Record<BookingState, BookingState[]> = {
  IDLE: ['SITE_DETECTED', 'STOPPED', 'FAILED'],
  SITE_DETECTED: ['SESSION_READY', 'IDLE', 'USER_ACTION_REQUIRED', 'FAILED', 'STOPPED'],
  SESSION_READY: ['BOOKING_PAGE_READY', 'USER_ACTION_REQUIRED', 'IDLE', 'FAILED', 'STOPPED'],
  BOOKING_PAGE_READY: ['PREPARING', 'SESSION_READY', 'IDLE', 'FAILED', 'STOPPED'],
  PREPARING: ['ARMED', 'FAILED', 'STOPPED', 'USER_ACTION_REQUIRED'],
  ARMED: ['WAITING_FOR_BOOKING_OPEN', 'IDLE', 'USER_ACTION_REQUIRED', 'FAILED', 'STOPPED'],
  WAITING_FOR_BOOKING_OPEN: ['BOOKING_OPEN', 'USER_ACTION_REQUIRED', 'FAILED', 'STOPPED'],
  BOOKING_OPEN: ['ROUTE_READY', 'SEARCHING', 'FAILED', 'STOPPED'],
  ROUTE_READY: ['DATE_READY', 'SEARCHING', 'FAILED', 'STOPPED'],
  DATE_READY: ['SEARCHING', 'FAILED', 'STOPPED'],
  SEARCHING: ['RESULTS_READY', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  RESULTS_READY: ['TRAIN_SELECTION', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  TRAIN_SELECTION: ['CLASS_SELECTION', 'RESULTS_READY', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  CLASS_SELECTION: ['SEAT_PANEL_READY', 'TRAIN_SELECTION', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  SEAT_PANEL_READY: ['COACH_SELECTION', 'SEAT_SELECTING', 'CLASS_SELECTION', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  COACH_SELECTION: ['SEAT_SELECTING', 'CLASS_SELECTION', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  SEAT_SELECTING: ['SEATS_CONFIRMED', 'COACH_SELECTION', 'CLASS_SELECTION', 'SECURITY_CHECK', 'USER_ACTION_REQUIRED', 'FAILED', 'STOPPED'],
  // PURCHASE_CONTINUE is deliberately NOT reachable from here. Committing the purchase is the
  // user's action; the engine hands over at SEATS_CONFIRMED and never presses that button. The
  // state remains declared so the flow can be resumed past it after the user commits manually.
  SEATS_CONFIRMED: ['USER_ACTION_REQUIRED', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  PURCHASE_CONTINUE: ['PASSENGER_PAGE', 'SECURITY_CHECK', 'PAYMENT_REQUIRED', 'USER_ACTION_REQUIRED', 'FAILED', 'STOPPED'],
  PASSENGER_PAGE: ['PASSENGERS_FILLING', 'USER_ACTION_REQUIRED', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  PASSENGERS_FILLING: ['PASSENGERS_COMPLETE', 'USER_ACTION_REQUIRED', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  PASSENGERS_COMPLETE: ['FINAL_REVIEW', 'PAYMENT_REQUIRED', 'SECURITY_CHECK', 'USER_ACTION_REQUIRED', 'FAILED', 'STOPPED'],
  SECURITY_CHECK: ['USER_ACTION_REQUIRED', 'STOPPED', 'FAILED'],
  USER_ACTION_REQUIRED: ['SECURITY_COMPLETE', 'STOPPED', 'FAILED'],
  SECURITY_COMPLETE: [
    'RESULTS_READY', 'TRAIN_SELECTION', 'CLASS_SELECTION', 'SEAT_PANEL_READY', 'SEAT_SELECTING',
    'SEATS_CONFIRMED', 'PASSENGER_PAGE', 'PASSENGERS_FILLING', 'FINAL_REVIEW',
    'PAYMENT_REQUIRED', 'CONFIRMATION', 'FAILED', 'STOPPED',
  ],
  FINAL_REVIEW: ['PAYMENT_REQUIRED', 'USER_ACTION_REQUIRED', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  PAYMENT_REQUIRED: ['USER_PAYMENT_REQUIRED', 'STOPPED', 'FAILED'],
  USER_PAYMENT_REQUIRED: ['CONFIRMATION', 'SECURITY_CHECK', 'FAILED', 'STOPPED'],
  CONFIRMATION: ['SUCCESS', 'FAILED', 'STOPPED'],
  SUCCESS: [],
  FAILED: ['IDLE'],
  STOPPED: ['IDLE'],
};

export interface TransitionRecord {
  from: BookingState;
  to: BookingState;
  reason: string;
  atPerf: number;
}

export class IllegalTransitionError extends Error {
  constructor(from: BookingState, to: BookingState) {
    super(`Illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export type StateListener = (state: BookingState, detail: string) => void;

export class StateMachine {
  private current: BookingState = 'IDLE';
  private enteredAt = nowPerf();
  private readonly history: TransitionRecord[] = [];
  private readonly listeners = new Set<StateListener>();

  get state(): BookingState {
    return this.current;
  }

  get msInState(): number {
    return nowPerf() - this.enteredAt;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.current);
  }

  get isWaitingOnHuman(): boolean {
    return HUMAN_STATES.has(this.current);
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canTransition(to: BookingState): boolean {
    return TRANSITIONS[this.current]?.includes(to) ?? false;
  }

  /**
   * Move to `to`. Throws on an undeclared transition - the engine catches this and fails
   * safely rather than continuing from an unexpected state.
   */
  transition(to: BookingState, reason = ''): void {
    if (to === this.current) return;
    if (!this.canTransition(to)) throw new IllegalTransitionError(this.current, to);

    const record: TransitionRecord = { from: this.current, to, reason, atPerf: nowPerf() };
    this.history.push(record);
    this.current = to;
    this.enteredAt = record.atPerf;

    logger.timing(`state ${record.from} -> ${to}${reason ? ` (${reason})` : ''}`, to);

    for (const listener of this.listeners) {
      try {
        listener(to, reason);
      } catch {
        /* a broken listener must never break the run */
      }
    }
  }

  /** Escape hatch used only by STOP and by unrecoverable failure. Always legal. */
  force(to: BookingState, reason: string): void {
    const record: TransitionRecord = { from: this.current, to, reason, atPerf: nowPerf() };
    this.history.push(record);
    this.current = to;
    this.enteredAt = record.atPerf;
    logger.timing(`state ${record.from} -> ${to} (forced: ${reason})`, to);
    for (const listener of this.listeners) {
      try {
        listener(to, reason);
      } catch {
        /* ignored */
      }
    }
  }

  transitions(): readonly TransitionRecord[] {
    return this.history;
  }

  reset(): void {
    this.current = 'IDLE';
    this.enteredAt = nowPerf();
    this.history.length = 0;
  }
}
