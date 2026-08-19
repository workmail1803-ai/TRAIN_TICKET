/**
 * THE ONLY FILE THAT HOLDS SITE FACTS.
 *
 * No selector literal may appear anywhere else in the codebase. When the site changes,
 * this file (or a runtime override in chrome.storage.local) is the only thing to patch.
 *
 * CONFIDENCE LEVELS
 *   'observed'   - read directly off a supplied screenshot. Visible text, labels,
 *                  placeholders, option strings. Reliable.
 *   'unverified' - inferred structure. No HTML has been supplied for this site, so ids,
 *                  classes and tag names are NOT known. Anything marked 'unverified' is a
 *                  fallback hint only; the finder never depends on it alone.
 *
 * Because structure is unknown, every descriptor leads with text/label/placeholder
 * matching, which is exactly what the supplied screenshots DO establish. CSS hints are
 * last-resort and are allowed to miss.
 */

export type Confidence = 'observed' | 'unverified';

export interface ElementDescriptor {
  /** Stable key used for overrides and logging. */
  key: string;
  purpose: string;
  confidence: Confidence;
  /** Resolution hints, tried in the order defined by element-finder.ts. */
  id?: string;
  name?: string;
  ariaLabel?: string;
  /** Text of a <label> that points at, wraps, or immediately precedes the control. */
  labelText?: string[];
  placeholder?: string[];
  /** Normalised, case-insensitive full-text match on the element itself. */
  text?: string[];
  /** Substring match on normalised text. Looser than `text`. */
  textContains?: string[];
  role?: string;
  tag?: string[];
  /** Last-resort CSS. Allowed to fail. Never the only hint. */
  css?: string[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * VERIFIED 2026-08-15: the extension loaded against this host and its content script
 * attached successfully.
 *
 * If it ever changes, change it HERE and in public/manifest.json (both `host_permissions`
 * and `content_scripts[0].matches`), then reload the unpacked extension.
 */
export const SITE = {
  originHint: 'eticket.railway.gov.bd',
  confidence: 'observed' as Confidence,
};

// ---------------------------------------------------------------------------
// Text constants observed on the site
// ---------------------------------------------------------------------------

export const TEXT = {
  searchButton: ['search trains'],
  bookNow: ['book now'],
  continuePurchase: ['continue purchase'],
  modifySearch: ['modify search'],
  trainDetails: ['train details'],
  close: ['close'],
  availableTickets: 'available tickets',
  counterOnline: '(counter + online)',
  includingVat: 'including vat',
  classPlaceholderOption: 'choose a class',
  seatDetails: 'seat details',
  boardingStation: 'boarding station',
  selectCoach: 'select coach',
  /** Legend labels, in seat-map order. */
  legend: {
    available: 'available',
    selected: 'selected',
    inProgress: 'in progress',
    booked: 'booked',
  },
  /** Live counters that mutate on their own — observers must never be scoped to these. */
  noisyCounters: ['users are trying to book', 'total active users on this page'],
} as const;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export const PATTERNS = {
  /** "MADHUMATI EXPRESS (756)" -> name, number */
  trainHeading: /^(.+?)\s*\((\d{2,5})\)\s*$/,
  /** "JHA - 2 Seat(s)" -> coach code, free seat count */
  coachOption: /^\s*([A-Za-z]+)\s*[-–]\s*(\d+)\s*Seat\(s\)\s*$/i,
  /** "KHA-19" -> coach, seat number */
  seatLabel: /^\s*([A-Za-z]+)\s*[-–]\s*(\d+)\s*$/,
  /** Pull the integer out of "Available Tickets (Counter + Online) 0" */
  seatsLeft: /available\s*tickets[^0-9]*?(\d+)/i,
  /** "৳1597" or "Tk 1597" or "1,597" */
  fare: /(?:৳|tk\.?|bdt)?\s*([\d,]+)/i,
  /** Calendar header, e.g. "August 2026" */
  calendarHeader: /^([A-Za-z]+)\s+(\d{4})$/,
} as const;

// ---------------------------------------------------------------------------
// Page 1 / header — session
// ---------------------------------------------------------------------------

export const SESSION = {
  userMenu: {
    key: 'session.userMenu',
    purpose: 'Logged-in user name in the header. Proof of a live session.',
    confidence: 'observed',
    tag: ['button', 'a', 'div'],
    css: ['header .dropdown-toggle', 'nav .user-menu', 'header [class*="user"]'],
    notes:
      'Observed as an outlined pill at top-right containing the account name, truncated ' +
      'with an ellipsis, plus a chevron. Detection is: header control whose text is neither ' +
      'a nav item nor a login/register word.',
  },
  loginLink: {
    key: 'session.loginLink',
    purpose: 'Presence means the session is NOT live.',
    confidence: 'unverified',
    tag: ['a', 'button'],
    textContains: ['login', 'log in', 'sign in', 'register'],
  },
} satisfies Record<string, ElementDescriptor>;

/** Header nav items, used to exclude them when hunting for the user menu. */
export const NAV_ITEMS = ['home', 'verify ticket', 'train information', 'contact us'];

// ---------------------------------------------------------------------------
// Page 2 — search form
// ---------------------------------------------------------------------------

export const SEARCH_FORM = {
  fromStation: {
    key: 'search.fromStation',
    purpose: 'Origin station input.',
    confidence: 'observed',
    labelText: ['from'],
    placeholder: ['from station'],
    tag: ['input'],
    css: ['#from_city', 'input[name="from_city"]'],
    notes: 'Autocomplete behaviour UNVERIFIED — dropdown was never captured open.',
  },
  toStation: {
    key: 'search.toStation',
    purpose: 'Destination station input.',
    confidence: 'observed',
    labelText: ['to'],
    placeholder: ['to station'],
    tag: ['input'],
    css: ['#to_city', 'input[name="to_city"]'],
  },
  journeyDate: {
    key: 'search.journeyDate',
    purpose: 'Journey date input that opens a custom calendar.',
    confidence: 'observed',
    labelText: ['date of journey'],
    placeholder: ['pick a date'],
    tag: ['input'],
    css: ['#datepicker', 'input[name="journey_date"]'],
    notes: 'Not a native date input — a JS calendar widget renders below it.',
  },
  travelClass: {
    key: 'search.travelClass',
    purpose: 'Native <select> for class.',
    confidence: 'observed',
    labelText: ['choose class'],
    tag: ['select'],
    css: ['#seat-class', 'select[name="seat_class"]'],
    notes:
      'Confirmed native <select>: OS dropdown arrow, and the open list rendered as a native ' +
      'listbox. Drive with value + change event, never click choreography.',
  },
  searchButton: {
    key: 'search.submit',
    purpose: 'SEARCH TRAINS submit button.',
    confidence: 'observed',
    tag: ['button', 'input', 'a'],
    text: ['search trains'],
    notes: 'Renders disabled until the form validates. Must waitForEnabled before clicking.',
  },
} satisfies Record<string, ElementDescriptor>;

/** Autocomplete suggestion list — shape UNVERIFIED, handled defensively. */
export const AUTOCOMPLETE = {
  container: {
    key: 'autocomplete.container',
    purpose: 'Station suggestion list that may appear while typing.',
    confidence: 'unverified',
    role: 'listbox',
    css: [
      '.autocomplete-items',
      '.ui-autocomplete',
      '[class*="suggestion"]',
      '[class*="autocomplete"]',
      'ul[role="listbox"]',
    ],
  },
  option: {
    key: 'autocomplete.option',
    purpose: 'A single station suggestion.',
    confidence: 'unverified',
    role: 'option',
    tag: ['li', 'div', 'button'],
  },
} satisfies Record<string, ElementDescriptor>;

// ---------------------------------------------------------------------------
// Calendar widget
// ---------------------------------------------------------------------------

export const CALENDAR = {
  container: {
    key: 'calendar.container',
    purpose: 'The calendar popup itself. RETIRED as a selector - see the note.',
    confidence: 'unverified',
    role: 'dialog',
    css: ['.datepicker', '.calendar', '[class*="datepicker"]'],
    notes:
      'DO NOT USE for resolution. On the live site `[class*="calendar"]` matched the calendar ' +
      'ICON inside the date field in 4ms, so the header was unreadable and no day cells existed. ' +
      'The picker is now located by content instead - findCalendarPopup() in form-filler.ts ' +
      'requires a Su..Sa weekday row, which only the real calendar has. Kept here for reference.',
  },
  header: {
    key: 'calendar.header',
    purpose: 'Month + year label, e.g. "August 2026".',
    confidence: 'observed',
    css: ['.datepicker-switch', '[class*="header"]', '[class*="title"]'],
  },
  prev: {
    key: 'calendar.prev',
    purpose: 'Previous month arrow.',
    confidence: 'observed',
    css: ['.prev', '[class*="prev"]'],
  },
  next: {
    key: 'calendar.next',
    purpose: 'Next month arrow.',
    confidence: 'observed',
    css: ['.next', '[class*="next"]'],
  },
  day: {
    key: 'calendar.day',
    purpose: 'A selectable day cell.',
    confidence: 'observed',
    tag: ['td', 'div', 'button', 'span'],
    css: ['td.day', '.day', '[class*="day"]'],
    notes:
      'Out-of-window days render greyed. Observed bookable window on 15-Aug-2026 was ' +
      '15..25 Aug, i.e. today + 10 days. Disabled cells must never be clicked.',
  },
} satisfies Record<string, ElementDescriptor>;

/** Class names commonly used for unselectable calendar days. Best-effort. */
export const CALENDAR_DISABLED_HINTS = [
  'disabled',
  'old',
  'new',
  'muted',
  'off',
  'unavailable',
];

// ---------------------------------------------------------------------------
// Page 3 — results
// ---------------------------------------------------------------------------

export const RESULTS = {
  trainHeading: {
    key: 'results.trainHeading',
    purpose: 'Clickable train row heading, e.g. "DHUMKETU EXPRESS (770)".',
    confidence: 'observed',
    tag: ['h1', 'h2', 'h3', 'h4', 'a', 'button', 'div', 'span'],
    notes:
      'Matched by the "NAME (NUMBER)" pattern rather than by class. Rows are an accordion, ' +
      'collapsed by default; class cards only exist once expanded.',
  },
  classCard: {
    key: 'results.classCard',
    purpose: 'A fare/availability card inside an expanded train.',
    confidence: 'observed',
    notes:
      'Identified by containing BOTH a known class token AND the "Available Tickets" text. ' +
      'This is structure-free and survives class-name churn.',
  },
  bookNow: {
    key: 'results.bookNow',
    purpose: 'BOOK NOW button inside a bookable class card.',
    confidence: 'observed',
    tag: ['button', 'a'],
    text: ['book now'],
    notes:
      'KEY FACT: rendered only when the class is actually bookable. Sold-out cards ' +
      '(count 0, pink fill) render no button at all. Presence is the primary bookability signal.',
  },
  modifySearch: {
    key: 'results.modifySearch',
    purpose: 'Returns to the search form.',
    confidence: 'observed',
    tag: ['button', 'a'],
    text: ['modify search'],
  },
} satisfies Record<string, ElementDescriptor>;

/**
 * The empty-results state, verified from the live site.
 *
 * This matters more than it looks. The SEARCH TRAINS button is enabled at all times, so
 * clicking it before the date is released does not fail - it returns this page. A click
 * dispatched a few milliseconds before the server releases the day lands here, which is
 * indistinguishable from a genuinely sold-out route unless the message is read.
 */
export const NO_RESULTS = {
  textHints: [
    'no train found for selected dates or cities',
    'no train found',
    'please try different dates or cities',
    'no trains found',
  ],
  confidence: 'observed' as Confidence,
} as const;

// ---------------------------------------------------------------------------
// Page 5 — seat selection
// ---------------------------------------------------------------------------

export const SEATS = {
  coachSelect: {
    key: 'seats.coachSelect',
    purpose: 'Native <select> listing coaches with their free-seat counts.',
    confidence: 'observed',
    labelText: ['select coach'],
    tag: ['select'],
    notes:
      'Option text embeds the count: "KHA - 0 Seat(s)", "JHA - 2 Seat(s)". Scanning every ' +
      'coach is therefore a pure read of the option list — no clicks, no re-renders.',
  },
  legend: {
    key: 'seats.legend',
    purpose: 'Available / Selected / In Progress / Booked swatches.',
    confidence: 'observed',
    notes:
      'Used to derive the colour of each seat state from the page itself instead of ' +
      'hard-coding colours. Survives any theme change.',
  },
  seatCell: {
    key: 'seats.seatCell',
    purpose: 'One seat button, e.g. "KHA-19".',
    confidence: 'observed',
    tag: ['button', 'div', 'span', 'li', 'a'],
    notes: 'Matched by the "COACH-NUMBER" text pattern. Observed layout 2 + aisle + 3.',
  },
  seatDetailsPanel: {
    key: 'seats.detailsPanel',
    purpose: 'Class / Seats / Fare table that fills in as seats are confirmed.',
    confidence: 'observed',
    textContains: ['seat details'],
    notes: 'This is the confirmation signal that a seat click was actually granted.',
  },
  boardingStation: {
    key: 'seats.boardingStation',
    purpose: 'Required boarding point <select>.',
    confidence: 'observed',
    labelText: ['boarding station'],
    tag: ['select'],
    notes: 'Marked required with a red asterisk. Observed pre-filled, but must be validated.',
  },
  continuePurchase: {
    key: 'seats.continuePurchase',
    purpose: 'Commits the selected seats.',
    confidence: 'observed',
    tag: ['button', 'a'],
    text: ['continue purchase'],
  },
  totalFare: {
    key: 'seats.totalFare',
    purpose: 'Running total, secondary confirmation that seats registered.',
    confidence: 'observed',
    textContains: ['total:'],
  },
} satisfies Record<string, ElementDescriptor>;

/**
 * Messages the site shows when a seat click is refused.
 *
 * Used to detect a lost race immediately instead of waiting for a confirmation that will never
 * arrive. Phrases are deliberately specific: "available" alone would match the standing
 * "Available Tickets (Counter + Online)" label.
 */
export const SEAT_FEEDBACK = {
  lostHints: [
    'already booked',
    'already selected',
    'already taken',
    'seat is not available',
    'not available',
    'no longer available',
    'please select another',
    'seat unavailable',
    'try another seat',
  ],
  confidence: 'unverified' as Confidence,
} as const;

// ---------------------------------------------------------------------------
// Page 6 — security verification (DETECTION ONLY)
// ---------------------------------------------------------------------------

/**
 * Detection only. The extension never reads, solves, submits, forwards or stores any
 * challenge content. It observes that a challenge exists, halts, and waits for the human.
 */
export const SECURITY = {
  iframeSrcHints: [
    'recaptcha',
    'hcaptcha',
    'turnstile',
    'challenges.cloudflare.com',
    'funcaptcha',
    'arkoselabs',
  ],
  domHints: [
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '#captcha',
    '[class*="captcha"]',
    '[id*="captcha"]',
  ],
  textHints: [
    'captcha',
    'verify you are human',
    'i am not a robot',
    "i'm not a robot",
    'security verification',
    'enter otp',
    'one time password',
    'one-time password',
    'verification code',
    'are you a robot',
  ],
} as const;

// ---------------------------------------------------------------------------
// Page 7 — payment (DETECTION ONLY)
// ---------------------------------------------------------------------------

export const PAYMENT = {
  /**
   * Action phrases only, and only on controls or headings.
   *
   * VERIFIED THE HARD WAY: the home page hero reads "Easy purchase of tickets using online
   * payment method" and carries a bKash / Nagad / Rocket / VISA logo strip. Broad hints like
   * "payment method", "mobile banking" or a wallet brand name match that marketing copy and
   * made the detector report the home page as the payment stage.
   */
  actionHints: [
    'proceed to payment',
    'continue to payment',
    'confirm payment',
    'make payment',
    'pay now',
    'select payment method',
    'choose payment method',
  ],
  /** Only these element types are considered - never arbitrary body text. */
  actionTags: ['button', 'a', 'h1', 'h2', 'h3', 'h4'],
  /** Leaving the site origin during a run is treated as entering the gateway. */
  offSiteMeansGateway: true,
} as const;

// ---------------------------------------------------------------------------
// Page 8 — confirmation
// ---------------------------------------------------------------------------

export const CONFIRMATION = {
  textHints: [
    'booking successful',
    'purchase successful',
    'ticket purchased',
    'payment successful',
    'booking confirmed',
    'thank you for purchasing',
  ],
  referenceLabels: ['pnr', 'booking reference', 'reference', 'transaction id', 'ticket number'],
  /** UNVERIFIED — no confirmation page has been supplied. */
  confidence: 'unverified' as Confidence,
} as const;

// ---------------------------------------------------------------------------
// Booking-open signal
// ---------------------------------------------------------------------------

/**
 * UNVERIFIED. Pre-08:00 site behaviour has not been described, so the primary signal is
 * unknown. Until it is, the engine uses the ordering in docs/01-architecture.md §4.5:
 * search button enable transition, then a "not open" notice disappearing, then the clock.
 */
export const BOOKING_OPEN = {
  notOpenTextHints: [
    'booking will open',
    'not open yet',
    'ticket sale will start',
    'sale starts at',
    'please wait',
    'counter closed',
  ],
  confidence: 'unverified' as Confidence,
} as const;
