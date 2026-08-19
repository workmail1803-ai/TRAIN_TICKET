import { CONFIRMATION, NAV_ITEMS, SEARCH_FORM, SEATS, SESSION, TEXT } from '@/selectors/railway-selectors';
import { findAll, findOne, isVisible, normText } from './element-finder';
import { detectPayment, detectSecurity } from './security-detector';
import { parseTrainRows } from './results-parser';

export type PageKind =
  | 'LOGIN'
  | 'HOME'
  | 'RESULTS'
  | 'SEAT'
  | 'PASSENGER'
  | 'SECURITY'
  | 'PAYMENT'
  | 'CONFIRMATION'
  | 'UNKNOWN';

export interface PageDetection {
  kind: PageKind;
  evidence: string;
  /** Low confidence means the engine must stop rather than act. */
  confident: boolean;
}

export interface SessionDetection {
  loggedIn: boolean;
  displayName: string | null;
  evidence: string;
}

const LOGIN_WORDS = ['login', 'log in', 'sign in', 'signin', 'register', 'sign up'];

/**
 * Session detection.
 *
 * The header renders the account name in a pill at top-right once logged in. We look for a
 * header control whose text is neither a nav item nor a login word. The name itself is used
 * only as evidence and is never stored or logged in full.
 */
export function detectSession(): SessionDetection {
  const header =
    document.querySelector<HTMLElement>('header') ??
    document.querySelector<HTMLElement>('nav') ??
    document.body;

  if (!header) return { loggedIn: false, displayName: null, evidence: 'no header' };

  const loginLink = findAll(SESSION.loginLink, { root: header })[0];
  if (loginLink && isVisible(loginLink)) {
    return { loggedIn: false, displayName: null, evidence: `login control visible` };
  }

  const controls = Array.from(
    header.querySelectorAll<HTMLElement>('button, a, [role="button"], .dropdown-toggle')
  ).filter((el) => isVisible(el));

  for (const el of controls) {
    const text = normText(el.textContent).replace(/[….]+$/, '').trim();
    if (!text || text.length < 3 || text.length > 60) continue;
    if (NAV_ITEMS.includes(text)) continue;
    if (LOGIN_WORDS.some((word) => text.includes(word))) continue;
    // Nav items sometimes render as links with the same shape; require it to look like a
    // name rather than a single common word.
    if (!/\s/.test(text) && text.length < 6) continue;

    return { loggedIn: true, displayName: el.textContent?.trim() ?? null, evidence: 'header user control' };
  }

  return { loggedIn: false, displayName: null, evidence: 'no user control in header' };
}

function hasSearchForm(): boolean {
  const from = findOne(SEARCH_FORM.fromStation);
  const to = findOne(SEARCH_FORM.toStation);
  const date = findOne(SEARCH_FORM.journeyDate);
  return !!from && !!to && !!date;
}

function hasSeatPanel(): boolean {
  const coach = findOne(SEATS.coachSelect);
  const commit = findOne(SEATS.continuePurchase);
  return !!coach || !!commit;
}

function hasConfirmation(): string | null {
  const body = normText(document.body?.innerText ?? '');
  return CONFIRMATION.textHints.find((hint) => body.includes(hint)) ?? null;
}

/**
 * Identify the current page.
 *
 * Order matters: a security challenge or a payment hand-off can appear on top of any other
 * page, so those are checked first. When nothing matches confidently the answer is UNKNOWN,
 * and UNKNOWN always means "stop", never "assume".
 */
export function detectPage(siteOrigin: string): PageDetection {
  // A challenge genuinely overlays any page, so it is the one thing checked first.
  const security = detectSecurity();
  if (security) {
    return { kind: 'SECURITY', evidence: security.evidence, confident: true };
  }

  // Structural evidence outranks text evidence. A page that contains the search form IS the
  // home page, whatever words happen to appear in its marketing copy - the original ordering
  // let the hero's "online payment method" text label the home page as the payment stage.
  // Seat panel before results: it opens as an overlay on top of the results page.
  if (hasSeatPanel()) {
    return { kind: 'SEAT', evidence: 'coach select / continue purchase present', confident: true };
  }

  const trains = parseTrainRows(1);
  if (trains.length > 0) {
    return { kind: 'RESULTS', evidence: `${trains.length} train rows`, confident: true };
  }

  if (hasSearchForm()) {
    return { kind: 'HOME', evidence: 'search form present', confident: true };
  }

  // Only now, with no structural signal, are text heuristics allowed to decide.
  const confirmation = hasConfirmation();
  if (confirmation) {
    return { kind: 'CONFIRMATION', evidence: `text:${confirmation}`, confident: true };
  }

  const payment = detectPayment(siteOrigin);
  if (payment) {
    return { kind: 'PAYMENT', evidence: payment.evidence, confident: true };
  }

  const session = detectSession();
  if (!session.loggedIn) {
    return { kind: 'LOGIN', evidence: session.evidence, confident: false };
  }

  // A passenger page is plausible here, but its DOM has never been supplied, so claiming it
  // would be a guess. UNKNOWN is the honest answer and it makes the engine stop.
  return { kind: 'UNKNOWN', evidence: 'no known page markers', confident: false };
}

/** True when the page still shows the "not open yet" style notice, if the site uses one. */
export function findNotOpenNotice(hints: readonly string[]): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('div, p, span, h1, h2, h3, section');
  for (const el of Array.from(candidates)) {
    if (el.children.length > 2) continue;
    if (!isVisible(el)) continue;
    const text = normText(el.textContent);
    if (!text || text.length > 200) continue;
    if (TEXT.noisyCounters.some((noise) => text.includes(noise))) continue;
    if (hints.some((hint) => text.includes(hint))) return el;
  }
  return null;
}
