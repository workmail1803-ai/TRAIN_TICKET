import { PATTERNS, SEAT_FEEDBACK, SEATS, TEXT } from '@/selectors/railway-selectors';
import type { CoachOption, CoachSpreadPolicy, SeatCell, SeatState } from '@/types';
import { findAll, findOne, isEnabled, isVisible, normText } from './element-finder';
import { realClick } from './dom-engine';
import { setNativeValue } from './form-filler';
import { waitFor, waitForQuiet } from '@/utils/wait';
import { logger } from '@/utils/logger';

/**
 * Seat engine - the contended step, and where the booking is actually won or lost.
 *
 * Two observed facts do the heavy lifting:
 *
 *   1. The coach <select> embeds each coach's free-seat count in its option text
 *      ("KHA - 0 Seat(s)", "JHA - 2 Seat(s)"). Scanning every coach is therefore a pure
 *      read of the option list - no clicks, no re-renders, effectively free.
 *
 *   2. The legend (Available / Selected / In Progress / Booked) tells us what each state
 *      looks like *on this page*. Seat state is derived from that legend rather than from
 *      hard-coded colours, so a theme change cannot silently break classification.
 *
 * "In Progress" means another user is holding that seat right now. A seat that renders as
 * available can be gone before our click lands. Rejection is the normal case, not an error.
 */

type RGB = [number, number, number];

const COLOUR_MATCH_THRESHOLD = 70; // Euclidean distance in RGB space.

function parseColour(value: string): RGB | null {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(value);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  // A transparent swatch reads as the page behind it, which for this design is white.
  if (alpha < 0.1) return [255, 255, 255];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function colourDistance(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// ---------------------------------------------------------------------------
// Coaches
// ---------------------------------------------------------------------------

export function parseCoachOption(rawLabel: string, value: string): CoachOption | null {
  const match = PATTERNS.coachOption.exec(rawLabel.trim());
  if (!match?.[1] || match[2] === undefined) return null;
  return {
    code: match[1].toUpperCase(),
    freeSeats: Number(match[2]),
    value,
    rawLabel: rawLabel.trim(),
  };
}

export function parseCoaches(select: HTMLSelectElement): CoachOption[] {
  const out: CoachOption[] = [];
  for (const option of Array.from(select.options)) {
    const parsed = parseCoachOption(option.textContent ?? '', option.value);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Order coaches to try.
 *
 * PREFER_SINGLE_ALLOW_SPLIT (the configured default): coaches that can seat the whole
 * remaining party come first, so the party stays together when that is possible; everything
 * else follows by descending free count, so a split still gets the maximum seats.
 */
export function rankCoaches(
  coaches: CoachOption[],
  remaining: number,
  policy: CoachSpreadPolicy,
  preferredCoach = ''
): CoachOption[] {
  const withSeats = coaches.filter((c) => c.freeSeats > 0);

  const byPolicy = (): CoachOption[] => {
    if (policy === 'SINGLE_ONLY') {
      return withSeats
        .filter((c) => c.freeSeats >= remaining)
        .sort((a, b) => a.freeSeats - b.freeSeats);
    }
    if (policy === 'ANY') {
      return withSeats.sort((a, b) => b.freeSeats - a.freeSeats);
    }

    const fits = withSeats
      .filter((c) => c.freeSeats >= remaining)
      // Smallest sufficient coach first: leaves the roomier coaches for other parties and
      // makes no difference to us.
      .sort((a, b) => a.freeSeats - b.freeSeats);
    const rest = withSeats
      .filter((c) => c.freeSeats < remaining)
      .sort((a, b) => b.freeSeats - a.freeSeats);

    return [...fits, ...rest];
  };

  const ordered = byPolicy();

  /**
   * A named coach goes first when it has seats.
   *
   * A preference, not a restriction. A coach with nothing free never reaches this list, so an
   * unavailable favourite is simply skipped and the next-best coach is used - which is the
   * behaviour asked for. It also never suppresses a coach: the rest of the order is unchanged.
   */
  const wanted = preferredCoach.trim().toUpperCase();
  if (!wanted) return ordered;

  const favourite = ordered.find((c) => c.code === wanted);
  if (!favourite) return ordered;

  return [favourite, ...ordered.filter((c) => c !== favourite)];
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export interface Legend {
  usable: boolean;
  colours: Partial<Record<SeatState, RGB>>;
}

function swatchColour(labelEl: HTMLElement): RGB | null {
  const probes: Array<() => string | null> = [
    () => (labelEl.previousElementSibling ? getComputedStyle(labelEl.previousElementSibling).backgroundColor : null),
    () => (labelEl.firstElementChild ? getComputedStyle(labelEl.firstElementChild).backgroundColor : null),
    () => getComputedStyle(labelEl, '::before').backgroundColor,
    () => {
      const first = labelEl.parentElement?.firstElementChild;
      return first && first !== labelEl ? getComputedStyle(first).backgroundColor : null;
    },
  ];

  for (const probe of probes) {
    const raw = probe();
    if (!raw) continue;
    const colour = parseColour(raw);
    if (colour) return colour;
  }
  return null;
}

/**
 * Read the legend once per panel. Cheap: at most a handful of getComputedStyle calls,
 * never on a hot path.
 */
export function readLegend(panel: HTMLElement): Legend {
  const wanted: Array<[SeatState, string]> = [
    ['AVAILABLE', TEXT.legend.available],
    ['SELECTED', TEXT.legend.selected],
    ['IN_PROGRESS', TEXT.legend.inProgress],
    ['BOOKED', TEXT.legend.booked],
  ];

  const colours: Partial<Record<SeatState, RGB>> = {};

  for (const [state, label] of wanted) {
    const el = Array.from(panel.querySelectorAll<HTMLElement>('span, div, label, li, p')).find(
      (candidate) => candidate.children.length === 0 && normText(candidate.textContent) === label
    );
    if (!el) continue;
    const colour = swatchColour(el);
    if (colour) colours[state] = colour;
  }

  // The legend is only usable if the states it defines are actually distinguishable.
  const entries = Object.entries(colours) as Array<[SeatState, RGB]>;
  let distinct = entries.length >= 2;
  for (let i = 0; i < entries.length && distinct; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (colourDistance(entries[i]![1], entries[j]![1]) < 30) {
        distinct = false;
        break;
      }
    }
  }

  if (!distinct) {
    logger.warn(
      `Seat legend not usable (${entries.length} swatches resolved, not mutually distinct). ` +
        'Falling back to attribute and class-name hints.'
    );
  }
  return { usable: distinct, colours };
}

// ---------------------------------------------------------------------------
// Seat classification
// ---------------------------------------------------------------------------

const CLASS_HINTS: Array<[SeatState, RegExp]> = [
  ['BOOKED', /\b(booked|sold|occupied|unavailable|taken)\b/],
  ['SELECTED', /\b(selected|active|chosen)\b/],
  ['IN_PROGRESS', /\b(in-?progress|processing|pending|hold(ing)?)\b/],
  ['AVAILABLE', /\b(available|free|open|vacant)\b/],
];

function classifyByHints(el: HTMLElement): SeatState | null {
  const cls = normText(el.className?.toString?.() ?? '');
  for (const [state, pattern] of CLASS_HINTS) {
    if (pattern.test(cls)) return state;
  }
  const aria = normText(el.getAttribute('aria-label') ?? '');
  for (const [state, pattern] of CLASS_HINTS) {
    if (pattern.test(aria)) return state;
  }
  return null;
}

/** All seat buttons currently rendered, matched by the "COACH-NUMBER" text pattern. */
export function findSeatElements(panel: HTMLElement): HTMLElement[] {
  const scan = panel.querySelectorAll<HTMLElement>('button, a, div, span, li, td');
  const hits: HTMLElement[] = [];

  for (const el of Array.from(scan)) {
    if (el.children.length > 0) continue; // seat labels are leaf nodes
    // Regex before visibility: the check that forces layout runs only on real candidates.
    if (!PATTERNS.seatLabel.test((el.textContent ?? '').trim())) continue;
    if (!isVisible(el)) continue;
    hits.push(el);
  }
  return hits;
}

/**
 * Classify every seat.
 *
 * getComputedStyle is expensive, so seats are grouped by their class signature first and
 * exactly one representative per group is measured - typically 4 or 5 calls for a 50-seat
 * coach instead of 50.
 */
/** State of a single seat. Same rules as the bulk pass, usable on the hot path. */
export function stateOf(element: HTMLElement, legend: Legend): SeatState {
  const hinted = classifyByHints(element);

  // Our own claim wins outright: some sites disable a seat once it is selected.
  if (hinted === 'SELECTED') return 'SELECTED';

  /**
   * The disabled attribute outranks any class-name hint.
   *
   * Order matters here. Checking hints first meant a disabled seat whose class happened to
   * contain "available" was reported AVAILABLE - and would have been clicked.
   */
  if (!isEnabled(element)) return 'BOOKED';

  if (hinted) return hinted;
  if (!legend.usable) return 'UNKNOWN';

  const colour = parseColour(getComputedStyle(element).backgroundColor);
  if (!colour) return 'UNKNOWN';

  let bestState: SeatState = 'UNKNOWN';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [candidate, reference] of Object.entries(legend.colours) as Array<[SeatState, RGB]>) {
    const distance = colourDistance(colour, reference);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestState = candidate;
    }
  }
  return bestDistance <= COLOUR_MATCH_THRESHOLD ? bestState : 'UNKNOWN';
}

export function classifySeats(panel: HTMLElement, legend: Legend): SeatCell[] {
  interface Row {
    target: HTMLElement;
    label: string;
    coach: string;
    number: number;
  }

  const rows: Row[] = [];
  const seen = new Set<HTMLElement>();

  for (const el of findSeatElements(panel)) {
    const raw = (el.textContent ?? '').trim();
    const match = PATTERNS.seatLabel.exec(raw);
    if (!match?.[1] || match[2] === undefined) continue;

    const target = el.matches('button, a') ? el : ((el.closest('button, a') as HTMLElement | null) ?? el);
    if (seen.has(target)) continue;
    seen.add(target);

    rows.push({
      target,
      label: raw.toUpperCase().replace(/\s+/g, ''),
      coach: match[1].toUpperCase(),
      number: Number(match[2]),
    });
  }

  /**
   * Measure EVERY seat, not one representative per class group.
   *
   * The earlier version grouped by class name and measured one seat per group. On the live site
   * that gave the whole grid a single verdict - it claimed 1 seat from a coach advertising 20
   * free. Correctness wins here: the reads are consecutive with no DOM writes between them, so
   * the browser does one style recalculation regardless of how many seats there are.
   */
  const states = new Map<HTMLElement, SeatState>();
  for (const row of rows) states.set(row.target, stateOf(row.target, legend));

  return rows.map((row) => ({
    label: row.label,
    coach: row.coach,
    number: row.number,
    state: states.get(row.target) ?? 'UNKNOWN',
    element: row.target,
  }));
}

/**
 * Seats the SITE says we hold, read from the Seat Details table.
 *
 * This is the authoritative list. Our own click bookkeeping can be wrong in either direction -
 * a slow grant looks like a refusal, and a colour read can mislead - but the site's own summary
 * is what the purchase will actually be made from.
 */
export function readClaimedSeats(detailsPanel: HTMLElement | null): string[] {
  if (!detailsPanel) return [];

  const found = new Set<string>();
  for (const el of Array.from(detailsPanel.querySelectorAll<HTMLElement>('td, div, span, li, p, strong'))) {
    if (el.children.length > 0) continue;
    for (const token of (el.textContent ?? '').trim().split(/[,\s]+/)) {
      if (PATTERNS.seatLabel.test(token)) found.add(token.toUpperCase().replace(/\s+/g, ''));
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export type ClaimStopReason =
  | 'TARGET_REACHED'
  | 'NO_MORE_SEATS'
  | 'UNCLASSIFIABLE'
  | 'ABORTED'
  | 'PANEL_LOST';

export interface ClaimOutcome {
  confirmed: string[];
  attempted: number;
  coachesTried: string[];
  stopReason: ClaimStopReason;
}

export interface ClaimContext {
  panel: HTMLElement;
  coachSelect: HTMLSelectElement | null;
  detailsPanel: HTMLElement | null;
  targetSeats: number;
  policy: CoachSpreadPolicy;
  /** Coach code to try first, e.g. "KHA". Empty or absent means no preference. */
  preferredCoach?: string;
  signal?: AbortSignal;
  onSeatConfirmed?: (label: string, index: number) => void;
}

/** The grid container: the closest ancestor shared by all seat elements. */
function gridContainer(panel: HTMLElement, seats: HTMLElement[]): HTMLElement {
  if (seats.length === 0) return panel;
  let current: HTMLElement | null = seats[0]!.parentElement;
  while (current && current !== panel) {
    if (seats.every((seat) => current!.contains(seat))) return current;
    current = current.parentElement;
  }
  return panel;
}

/**
 * Confirm a seat click actually took. Waits for either the seat itself flipping to
 * Selected, or the Seat Details table naming it. Whichever arrives first wins.
 */
export type SeatOutcome = 'GRANTED' | 'LOST' | 'TIMEOUT';

/** A refusal message inside the seat panel. Scoped tightly to avoid false positives. */
function lostMessage(panel: HTMLElement): string | null {
  for (const el of Array.from(panel.querySelectorAll<HTMLElement>('div, span, p, li, strong'))) {
    if (el.children.length > 1) continue;
    if (!isVisible(el)) continue;
    const text = normText(el.textContent);
    if (!text || text.length > 120) continue;
    const hit = SEAT_FEEDBACK.lostHints.find((hint) => text.includes(hint));
    if (hit) return hit;
  }
  return null;
}

/**
 * Wait for the site to settle the race for one seat.
 *
 * Two other people can click the same seat in the same moment; only one gets it. The naive
 * approach - wait for confirmation, give up on timeout - pays the full timeout for every seat
 * lost, and under contention that is most of them. Three seats lost at 2.5 s each is most of the
 * window gone.
 *
 * So a loss is detected POSITIVELY. The site already announces it: the seat flips to Booked, or
 * to In Progress because someone else is now holding it, or a refusal message appears. Any of
 * those resolves in the time it takes the page to repaint, and the caller moves straight to the
 * next seat. The timeout remains only as a backstop for a genuinely unresponsive server.
 */
async function awaitSeatOutcome(
  context: ClaimContext,
  seat: SeatCell,
  legend: Legend
): Promise<SeatOutcome> {
  const outcome = await waitFor<SeatOutcome>(
    () => {
      // Granted: the site's own summary lists it. This is the authority.
      if (context.detailsPanel && readClaimedSeats(context.detailsPanel).includes(seat.label)) {
        return 'GRANTED';
      }

      // The seat vanished from the DOM - the grid re-rendered underneath us. Re-scan rather
      // than sit here waiting on a detached node.
      if (!seat.element.isConnected) return 'LOST';

      const state = stateOf(seat.element, legend);
      if (state === 'SELECTED') return 'GRANTED';

      // Lost: somebody else got it, or is holding it right now.
      if (state === 'BOOKED' || state === 'IN_PROGRESS') return 'LOST';

      if (lostMessage(context.panel)) return 'LOST';

      return null;
    },
    {
      what: `seat ${seat.label} outcome`,
      timeoutMs: 2500,
      // Scoped to the panel so the grid and the summary table are both covered.
      scope: context.panel,
      signal: context.signal,
      pollMs: 40,
    }
  ).catch(() => 'TIMEOUT' as SeatOutcome);

  return outcome;
}

async function switchCoach(context: ClaimContext, coach: CoachOption): Promise<boolean> {
  const select = context.coachSelect;
  if (!select) return false;
  if (select.value === coach.value) return true;

  const seatsBefore = findSeatElements(context.panel);
  const grid = gridContainer(context.panel, seatsBefore);

  setNativeValue(select, coach.value);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));

  // Switching coach redraws the whole grid; there is no single element whose appearance
  // means "done", so wait for the redraw to go quiet.
  await waitForQuiet(grid, 120, {
    what: `coach ${coach.code} grid render`,
    timeoutMs: 4000,
    signal: context.signal,
  }).catch(() => undefined);

  return true;
}

/**
 * Claim up to `targetSeats`, one at a time, each confirmed before moving on.
 *
 * Deliberately sequential. Firing concurrent seat clicks would be a server-hammering
 * pattern and the site's own hold logic would reject them anyway.
 */
/**
 * Choose which free seat to attempt.
 *
 * Randomised rather than always taking the first one on the grid. Under contention everybody
 * scanning top-left collides on the same seat; spreading the choice across the free seats makes
 * a head-on race less likely. It is the same decision a person makes when picking a seat, and it
 * changes nothing about what the server allows - it only avoids everyone queueing for seat 1.
 */
function pickCandidate(free: SeatCell[]): SeatCell | undefined {
  if (free.length <= 1) return free[0];
  return free[Math.floor(Math.random() * free.length)];
}

/** Wall-clock budget for the whole seat stage. */
const SEAT_STAGE_BUDGET_MS = 45_000;

export async function claimSeats(context: ClaimContext): Promise<ClaimOutcome> {
  const coachesTried: string[] = [];
  const rejected = new Set<string>();
  const deadline = performance.now() + SEAT_STAGE_BUDGET_MS;
  let attempted = 0;
  let lostRaces = 0;

  const legend = readLegend(context.panel);

  /** What the site's own summary says we hold. Empty when the panel is missing or lagging. */
  const held = (): string[] => readClaimedSeats(context.detailsPanel);
  let confirmed: string[] = held();

  /** Re-resolve the coach picker if a re-render replaced it. */
  const coachSelect = (): HTMLSelectElement | null => {
    if (context.coachSelect?.isConnected) return context.coachSelect;
    const found = findOne(SEATS.coachSelect) as HTMLSelectElement | null;
    if (found) context.coachSelect = found;
    return found;
  };

  /**
   * Sweep the coaches repeatedly rather than once.
   *
   * The previous version built the coach queue a single time, walked it, and gave up - so a run
   * that secured 2 of 4 stopped even though seats were freeing up the whole time (every other
   * user who loses a race or abandons a hold releases one). Each sweep re-reads the coach
   * counts, which is free, and gives previously lost seats another chance.
   */
  const MAX_SWEEPS = 4;

  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    if (confirmed.length >= context.targetSeats) break;
    if (context.signal?.aborted) return { confirmed, attempted, coachesTried, stopReason: 'ABORTED' };
    if (performance.now() > deadline) break;
    if (!context.panel.isConnected) {
      return { confirmed, attempted, coachesTried, stopReason: 'PANEL_LOST' };
    }

    // A seat lost on an earlier sweep may well be free again by now.
    if (sweep > 0) rejected.clear();

    const select = coachSelect();
    const coaches = select ? parseCoaches(select) : [];
    const remaining = context.targetSeats - confirmed.length;

    if (sweep > 0 && coaches.length > 0 && coaches.every((c) => c.freeSeats === 0)) {
      logger.info('No coach reports a free seat any more - ending the sweep');
      break;
    }

    const preferred = (context.preferredCoach ?? '').trim();
    const ranked = rankCoaches(coaches, remaining, context.policy, preferred);
    const currentCoach = coaches.find((c) => c.value === select?.value);

    /**
     * Try the coach already on screen first when it can help - it saves a full grid redraw.
     * But an explicit coach preference outranks that optimisation: saving a redraw is not worth
     * silently ignoring what the user asked for.
     */
    const order =
      !preferred && currentCoach && currentCoach.freeSeats > 0
        ? [currentCoach, ...ranked.filter((c) => c.value !== currentCoach.value)]
        : ranked;

    if (sweep === 0 && preferred) {
      const favourite = coaches.find((c) => c.code === preferred.toUpperCase());
      logger.info(
        favourite && favourite.freeSeats > 0
          ? `Preferred coach ${favourite.code} has ${favourite.freeSeats} free seat(s) - trying it first`
          : `Preferred coach ${preferred.toUpperCase()} has no free seats - using the next available coach`
      );
    }

    const queue = order.length > 0 ? order : [null];

    if (sweep > 0) {
      logger.info(
        `Sweep ${sweep + 1}: still ${remaining} seat(s) short, re-checking ` +
          `${coaches.filter((c) => c.freeSeats > 0).length} coach(es) with free seats`
      );
    }

    for (const coach of queue) {
      if (confirmed.length >= context.targetSeats) break;
      if (context.signal?.aborted) {
        return { confirmed, attempted, coachesTried, stopReason: 'ABORTED' };
      }
      if (performance.now() > deadline) break;
      if (!context.panel.isConnected) {
        return { confirmed, attempted, coachesTried, stopReason: 'PANEL_LOST' };
      }

      if (coach) {
        if (!coachesTried.includes(coach.code)) coachesTried.push(coach.code);
        const switched = await switchCoach(context, coach);
        if (!switched) continue;
      }

      /**
       * Bounded two ways: by attempts and by wall clock.
       *
       * Every pass either claims a seat or removes one from contention, so it cannot spin. The
       * allowance is generous because a lost race now costs a repaint rather than a timeout, and
       * losing several in a row is normal at 08:00. The clock budget is the backstop for the
       * case where the server itself has stopped answering.
       */
      const maxPasses = context.targetSeats * 6 + 12;

      for (let pass = 0; pass < maxPasses; pass++) {
        if (confirmed.length >= context.targetSeats) break;
        if (context.signal?.aborted) {
          return { confirmed, attempted, coachesTried, stopReason: 'ABORTED' };
        }
        if (performance.now() > deadline) {
          logger.warn('Seat stage budget exhausted - stopping with what has been secured');
          break;
        }

        /**
         * Re-classify on EVERY pass rather than working from one snapshot.
         *
         * Claiming a seat re-renders the grid, which invalidates cached element references, and
         * other users release holds while we work. A stale list meant later clicks landed on
         * detached nodes and silently did nothing.
         */
        const cells = classifySeats(context.panel, legend);

        if (cells.length > 0 && cells.every((c) => c.state === 'UNKNOWN')) {
          logger.error('Seat states could not be classified - stopping instead of clicking blind');
          return { confirmed, attempted, coachesTried, stopReason: 'UNCLASSIFIABLE' };
        }

        const free = cells.filter((c) => c.state === 'AVAILABLE' && !rejected.has(c.label));

        if (pass === 0) {
          const advertised = coach ? `${coach.freeSeats} advertised` : 'count unknown';
          logger.info(
            `Coach ${coach?.code ?? '(current)'}: ${free.length} selectable of ${cells.length} seats (${advertised})`
          );
          if (coach && coach.freeSeats > 0 && free.length === 0) {
            logger.warn(
              `Coach ${coach.code} advertises ${coach.freeSeats} free seats but none read as ` +
                'selectable. Either they were just taken, or seat colours are not being read correctly.'
            );
          }
        }

        const seat = pickCandidate(free);
        if (!seat) break;

        attempted++;
        realClick(seat.element);

        const outcome = await awaitSeatOutcome(context, seat, legend);

        // Re-read from the site rather than trusting our own bookkeeping.
        const nowHeld = held();

        if (outcome === 'GRANTED' || nowHeld.length > confirmed.length) {
          /**
           * The site's summary wins WHEN IT HAS SOMETHING TO SAY; otherwise keep our own record.
           *
           * The previous line read `nowHeld.length >= confirmed.length ? nowHeld : ...`, which
           * discarded a granted seat whenever the summary was empty - both when the Seat Details
           * panel could not be resolved at all, and when the table simply lagged a beat behind
           * the click. With confirmed stuck at 0 the target was never reached, so the loop kept
           * claiming seats: it under-reported to the user AND could hold more than the requested
           * number. A granted seat must never vanish from the count.
           */
          confirmed =
            nowHeld.length > 0
              ? nowHeld
              : confirmed.includes(seat.label)
                ? confirmed
                : [...confirmed, seat.label];
          lostRaces = 0;
          context.onSeatConfirmed?.(seat.label, confirmed.length);
          logger.info(`Seat confirmed ${seat.label} (${confirmed.length}/${context.targetSeats})`);
        } else {
          // Expected under contention, not an error. Move on at once - the next pass re-reads
          // the grid, so a seat freed by someone else's failure is picked up too.
          rejected.add(seat.label);
          lostRaces++;
          logger.info(
            outcome === 'LOST'
              ? `Lost the race for ${seat.label} - taking another seat immediately`
              : `No response for ${seat.label} - treating as taken and moving on`
          );
        }
      }
    }
  }

  if (lostRaces >= 5) {
    logger.warn(`${lostRaces} consecutive seats lost to other users - the coach is heavily contested`);
  }

  // Final reconciliation: whatever the site says we hold is what we hold.
  const finalHeld = held();
  if (finalHeld.length > 0) confirmed = finalHeld;

  return {
    confirmed,
    attempted,
    coachesTried,
    stopReason: confirmed.length >= context.targetSeats ? 'TARGET_REACHED' : 'NO_MORE_SEATS',
  };
}

// ---------------------------------------------------------------------------
// Panel resolution
// ---------------------------------------------------------------------------

export interface SeatPanelHandles {
  panel: HTMLElement;
  coachSelect: HTMLSelectElement | null;
  detailsPanel: HTMLElement | null;
  boardingSelect: HTMLSelectElement | null;
  continueButton: HTMLElement | null;
}

export function resolveSeatPanel(): SeatPanelHandles | null {
  const coachSelect = findOne(SEATS.coachSelect) as HTMLSelectElement | null;
  const continueButton = findOne(SEATS.continuePurchase);
  const detailsPanel = findOne(SEATS.seatDetailsPanel);

  const anchor = coachSelect ?? continueButton ?? detailsPanel;
  if (!anchor) return null;

  // The panel is the smallest ancestor holding both the coach picker and the commit button.
  let panel: HTMLElement = anchor;
  let current: HTMLElement | null = anchor.parentElement;
  while (current && current !== document.body) {
    const holdsCoach = !coachSelect || current.contains(coachSelect);
    const holdsContinue = !continueButton || current.contains(continueButton);
    if (holdsCoach && holdsContinue) {
      panel = current;
      break;
    }
    current = current.parentElement;
  }

  return {
    panel,
    coachSelect,
    detailsPanel,
    boardingSelect: (findAll(SEATS.boardingStation, { root: panel })[0] as HTMLSelectElement | null) ?? null,
    continueButton,
  };
}
