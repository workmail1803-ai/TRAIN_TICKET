/** Shared vocabulary for every context (content script, service worker, popup, options). */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export const BOOKING_STATES = [
  'IDLE',
  'SITE_DETECTED',
  'SESSION_READY',
  'BOOKING_PAGE_READY',
  'PREPARING',
  'ARMED',
  'WAITING_FOR_BOOKING_OPEN',
  'BOOKING_OPEN',
  'ROUTE_READY',
  'DATE_READY',
  'SEARCHING',
  'RESULTS_READY',
  'TRAIN_SELECTION',
  'CLASS_SELECTION',
  // Added states: seat selection is real on this site and is where the booking
  // is actually won or lost. See docs/01-architecture.md §3.
  'SEAT_PANEL_READY',
  'COACH_SELECTION',
  'SEAT_SELECTING',
  'SEATS_CONFIRMED',
  'PURCHASE_CONTINUE',
  'PASSENGER_PAGE',
  'PASSENGERS_FILLING',
  'PASSENGERS_COMPLETE',
  'SECURITY_CHECK',
  'USER_ACTION_REQUIRED',
  'SECURITY_COMPLETE',
  'FINAL_REVIEW',
  'PAYMENT_REQUIRED',
  'USER_PAYMENT_REQUIRED',
  'CONFIRMATION',
  'SUCCESS',
  'FAILED',
  'STOPPED',
] as const;

export type BookingState = (typeof BOOKING_STATES)[number];

/** States from which no further automated transition happens. */
export const TERMINAL_STATES: ReadonlySet<BookingState> = new Set<BookingState>([
  'SUCCESS',
  'FAILED',
  'STOPPED',
]);

/** States where we are deliberately waiting on the human, not the site. */
export const HUMAN_STATES: ReadonlySet<BookingState> = new Set<BookingState>([
  'USER_ACTION_REQUIRED',
  'USER_PAYMENT_REQUIRED',
]);

// ---------------------------------------------------------------------------
// Site domain model
// ---------------------------------------------------------------------------

/**
 * Class tokens, verified from the open "Choose Class" dropdown.
 * Order here mirrors the order the site renders them.
 */
export const TRAVEL_CLASSES = [
  'AC_B',
  'AC_S',
  'SNIGDHA',
  'F_BERTH',
  'F_SEAT',
  'F_CHAIR',
  'S_CHAIR',
  'SHOVAN',
  'SHULOV',
  'AC_CHAIR',
] as const;

export type TravelClass = (typeof TRAVEL_CLASSES)[number];

export type Availability =
  | 'AVAILABLE'
  | 'LIMITED'
  | 'SOLD_OUT'
  /** Enum member retained from spec; no waitlist state has been observed on this site. */
  | 'WAITLIST'
  | 'UNKNOWN';

/** Mirrors the seat-map legend: Available / Selected / In Progress / Booked. */
export type SeatState = 'AVAILABLE' | 'SELECTED' | 'IN_PROGRESS' | 'BOOKED' | 'UNKNOWN';

export interface ClassOffer {
  /** e.g. "S_CHAIR". Normalised upper-case token. */
  className: string;
  /** Numeric fare if parseable, else null. Display only — never used for decisions. */
  fare: number | null;
  /** Parsed from "Available Tickets (Counter + Online)". null when unparseable. */
  seatsLeft: number | null;
  availability: Availability;
  /**
   * The site only renders BOOK NOW on cards that can actually be booked.
   * This is the primary bookability signal; seatsLeft is corroboration.
   */
  hasBookNow: boolean;
  element: HTMLElement;
  bookNowElement: HTMLElement | null;
}

export interface TrainResult {
  /** e.g. "MADHUMATI EXPRESS" */
  name: string;
  /** e.g. "756" — parsed from the trailing parenthesis. */
  number: string | null;
  /** Raw heading text, kept for logging and for exact user matching. */
  rawLabel: string;
  expanded: boolean;
  departure: string | null;
  arrival: string | null;
  duration: string | null;
  classes: ClassOffer[];
  element: HTMLElement;
  headerElement: HTMLElement;
}

export interface CoachOption {
  /** e.g. "JHA" */
  code: string;
  /** Free seats, parsed from "JHA - 2 Seat(s)". */
  freeSeats: number;
  /** The <option> value attribute, used to drive the select. */
  value: string;
  rawLabel: string;
}

export interface SeatCell {
  /** e.g. "KHA-19" */
  label: string;
  coach: string;
  number: number;
  state: SeatState;
  element: HTMLElement;
}

// ---------------------------------------------------------------------------
// User configuration
// ---------------------------------------------------------------------------

export interface PassengerProfile {
  id: string;
  name: string;
  /** Kept as a string: the site's expected format is UNVERIFIED. */
  age: string;
  gender: string;
  passengerType: string;
  /** Optional free-form extras, so unmapped fields can be filled once known. */
  extra: Record<string, string>;
}

export interface JourneyConfig {
  fromStation: string;
  toStation: string;
  /** ISO yyyy-mm-dd. Converted to the site's display format at fill time. */
  dateISO: string;
  /** Class used for the search form itself. */
  searchClass: TravelClass | '';
}

export interface PreferenceConfig {
  /** Highest priority first. Matched against the train heading text. */
  trainPriority: string[];
  /** Highest priority first. Matched against class-card tokens. */
  classPriority: TravelClass[];
}

export type PartialPolicy = 'TAKE_AVAILABLE_THEN_STOP' | 'ALL_OR_NOTHING' | 'TAKE_AND_KEEP_TRYING';
export type CoachSpreadPolicy = 'PREFER_SINGLE_ALLOW_SPLIT' | 'SINGLE_ONLY' | 'ANY';

export interface SeatPolicy {
  targetSeats: number;
  partial: PartialPolicy;
  coachSpread: CoachSpreadPolicy;
  /**
   * Coach code to try first, e.g. "KHA". Empty means no preference.
   *
   * A preference, not a restriction: if the coach has no free seats it is skipped and the normal
   * ranking takes over. Independent of coachSpread, which governs what happens after the first
   * coach is chosen.
   */
  preferredCoach: string;
}

export interface ScheduleConfig {
  /** Wall-clock opening time in Asia/Dhaka, "HH:mm:ss". */
  openTimeBST: string;
  /**
   * Milliseconds added to the computed T0. Negative fires early.
   * Default 0 — firing early can land on an error page and cost more than it saves.
   */
  offsetMs: number;
  /** When true, T0 alone may trigger the flow if no site signal is observed. */
  allowClockFallback: boolean;
  /** How long after T0 to keep watching before giving up. */
  maxWaitAfterT0Ms: number;
  /**
   * Before the date is released the site answers a valid search with "No train found".
   * A click a few ms early lands there, so the search is re-submitted this many times.
   */
  maxEmptyRetries: number;
  /** Gap between those re-submissions. Kept polite - this is a handful of normal searches. */
  emptyRetryGapMs: number;
}

export interface AppConfig {
  schemaVersion: number;
  journey: JourneyConfig;
  preferences: PreferenceConfig;
  seatPolicy: SeatPolicy;
  schedule: ScheduleConfig;
  passengers: PassengerProfile[];
  /** Runtime patches to the selector registry, so the site can change without a rebuild. */
  selectorOverrides: Record<string, unknown>;
  /** Passenger auto-fill stays off until the passenger page DOM has been verified. */
  enablePassengerAutofill: boolean;
}

// ---------------------------------------------------------------------------
// Runtime / reporting
// ---------------------------------------------------------------------------

export interface LogEntry {
  /** Wall clock, for human reading. */
  wall: string;
  /** performance.now() at the moment of the event, for measurement. */
  perf: number;
  level: 'info' | 'warn' | 'error' | 'timing';
  message: string;
  detail?: string;
}

export interface TimelineMark {
  label: string;
  perf: number;
  state: BookingState;
}

export interface RunState {
  state: BookingState;
  stateEnteredAtPerf: number;
  stateEnteredAtWall: number;
  /** Index into trainPriority currently being attempted. */
  trainIdx: number;
  /** Index into classPriority currently being attempted. */
  classIdx: number;
  confirmedSeats: string[];
  lastError: string | null;
  /** Set when automation halted and is waiting for the human. */
  awaitingUserReason: string | null;
}

export interface BookingResult {
  reference: string | null;
  train: string | null;
  date: string | null;
  route: string | null;
  travelClass: string | null;
  passengerCount: number;
  seats: string[];
  capturedAtWall: number;
}

export interface ValidationIssue {
  field: string;
  message: string;
}
