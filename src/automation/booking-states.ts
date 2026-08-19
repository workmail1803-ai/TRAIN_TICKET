import type { BookingState } from '@/types';

/**
 * Per-state policy: how long to wait, how many times to retry, and what failure means.
 *
 * These are deliberately short. At 08:00 a long wait on a failing step is worse than a
 * clean fallback, because the engine has cheaper alternatives (next class, next train) than
 * grinding on the step that is already stuck.
 */

export interface StatePolicy {
  /** What this state is trying to achieve. */
  goal: string;
  timeoutMs: number;
  retries: number;
  /** Where to go when the goal is not achieved. */
  onFailure: BookingState;
  /** True when a timeout here is expected under contention rather than a real fault. */
  contentionExpected?: boolean;
}

export const STATE_POLICY: Partial<Record<BookingState, StatePolicy>> = {
  SITE_DETECTED: { goal: 'Confirm this is the railway site', timeoutMs: 5_000, retries: 1, onFailure: 'IDLE' },
  SESSION_READY: { goal: 'Confirm a live logged-in session', timeoutMs: 3_000, retries: 1, onFailure: 'USER_ACTION_REQUIRED' },
  BOOKING_PAGE_READY: { goal: 'Resolve the search form', timeoutMs: 5_000, retries: 1, onFailure: 'FAILED' },
  PREPARING: { goal: 'Validate config and pre-fill the form', timeoutMs: 15_000, retries: 0, onFailure: 'FAILED' },
  WAITING_FOR_BOOKING_OPEN: { goal: 'Detect the booking window opening', timeoutMs: 120_000, retries: 0, onFailure: 'FAILED' },
  BOOKING_OPEN: { goal: 'Confirm the form is still populated', timeoutMs: 2_000, retries: 1, onFailure: 'FAILED' },
  ROUTE_READY: { goal: 'Verify origin and destination committed', timeoutMs: 2_500, retries: 1, onFailure: 'FAILED' },
  DATE_READY: { goal: 'Verify the journey date committed', timeoutMs: 3_000, retries: 1, onFailure: 'FAILED' },
  SEARCHING: { goal: 'Submit the search and await results', timeoutMs: 12_000, retries: 2, onFailure: 'FAILED' },
  RESULTS_READY: { goal: 'Parse the train list', timeoutMs: 6_000, retries: 1, onFailure: 'FAILED' },
  TRAIN_SELECTION: { goal: 'Expand the preferred train', timeoutMs: 4_000, retries: 2, onFailure: 'FAILED' },
  CLASS_SELECTION: { goal: 'Open the seat panel for the preferred class', timeoutMs: 8_000, retries: 1, onFailure: 'FAILED', contentionExpected: true },
  SEAT_PANEL_READY: { goal: 'Resolve coach picker, grid and commit button', timeoutMs: 5_000, retries: 1, onFailure: 'FAILED' },
  COACH_SELECTION: { goal: 'Choose a coach with free seats', timeoutMs: 4_000, retries: 1, onFailure: 'CLASS_SELECTION' },
  SEAT_SELECTING: { goal: 'Claim seats, each individually confirmed', timeoutMs: 30_000, retries: 0, onFailure: 'USER_ACTION_REQUIRED', contentionExpected: true },
  SEATS_CONFIRMED: { goal: 'Validate boarding station', timeoutMs: 3_000, retries: 1, onFailure: 'USER_ACTION_REQUIRED' },
  PURCHASE_CONTINUE: { goal: 'Commit the seat selection', timeoutMs: 10_000, retries: 1, onFailure: 'FAILED' },
  PASSENGER_PAGE: { goal: 'Detect the passenger form', timeoutMs: 8_000, retries: 1, onFailure: 'USER_ACTION_REQUIRED' },
  PASSENGERS_FILLING: { goal: 'Fill and verify each passenger', timeoutMs: 10_000, retries: 1, onFailure: 'USER_ACTION_REQUIRED' },
  USER_PAYMENT_REQUIRED: { goal: 'Wait for the user to complete payment', timeoutMs: 900_000, retries: 0, onFailure: 'FAILED' },
  CONFIRMATION: { goal: 'Extract the booking reference', timeoutMs: 12_000, retries: 2, onFailure: 'FAILED' },
};

/** Human-facing one-liners for the popup. */
export const STATE_LABEL: Record<BookingState, string> = {
  IDLE: 'Idle',
  SITE_DETECTED: 'Railway site detected',
  SESSION_READY: 'Session verified',
  BOOKING_PAGE_READY: 'Booking page ready',
  PREPARING: 'Preparing…',
  ARMED: 'Armed',
  WAITING_FOR_BOOKING_OPEN: 'Waiting for booking to open',
  BOOKING_OPEN: 'Booking open',
  ROUTE_READY: 'Route set',
  DATE_READY: 'Date set',
  SEARCHING: 'Searching for trains…',
  RESULTS_READY: 'Results loaded',
  TRAIN_SELECTION: 'Selecting train…',
  CLASS_SELECTION: 'Selecting class…',
  SEAT_PANEL_READY: 'Seat map open',
  COACH_SELECTION: 'Choosing coach…',
  SEAT_SELECTING: 'Claiming seats…',
  SEATS_CONFIRMED: 'Seats confirmed',
  PURCHASE_CONTINUE: 'Continuing purchase…',
  PASSENGER_PAGE: 'Passenger page',
  PASSENGERS_FILLING: 'Filling passengers…',
  PASSENGERS_COMPLETE: 'Passengers complete',
  SECURITY_CHECK: 'Security verification detected',
  USER_ACTION_REQUIRED: 'YOUR ACTION REQUIRED',
  SECURITY_COMPLETE: 'Resuming…',
  FINAL_REVIEW: 'Final review',
  PAYMENT_REQUIRED: 'Payment stage',
  USER_PAYMENT_REQUIRED: 'COMPLETE PAYMENT YOURSELF',
  CONFIRMATION: 'Reading confirmation…',
  SUCCESS: 'BOOKING SUCCESSFUL',
  FAILED: 'Failed',
  STOPPED: 'Stopped',
};
