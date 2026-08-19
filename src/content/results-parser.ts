import { NO_RESULTS, PATTERNS, RESULTS, TEXT } from '@/selectors/railway-selectors';
import { TRAVEL_CLASSES, type Availability, type ClassOffer, type TrainResult } from '@/types';
import { elementText, findByText, isVisible, normText } from './element-finder';

/**
 * Results parser.
 *
 * Works entirely from text and shape, never from a single CSS class, because no HTML for
 * this site has been supplied. Two site facts observed from the screenshots carry the load:
 *
 *   1. Train headings read "NAME (NUMBER)" - e.g. "DHUMKETU EXPRESS (770)".
 *   2. A class card is bookable if and only if it renders a BOOK NOW button. Sold-out cards
 *      (count 0, pink fill) render no button at all. That presence check is far more robust
 *      than reading a colour or a count.
 */

/**
 * Given an element and a set of sibling "anchors", walk up to the largest ancestor that
 * still contains only this anchor. That is the row container, found without knowing a
 * single class name.
 */
function isolatedAncestor(anchor: HTMLElement, otherAnchors: HTMLElement[]): HTMLElement {
  let best = anchor;
  let current: HTMLElement | null = anchor.parentElement;

  while (current && current !== document.body) {
    if (otherAnchors.some((other) => other !== anchor && current!.contains(other))) break;
    best = current;
    current = current.parentElement;
  }
  return best;
}

/**
 * Heading elements that look like "NAME (NUMBER)" and nothing deeper.
 *
 * Ordering here is a performance decision, not a style one. This runs on every mutation while
 * waiting for results, over the whole document. The cheap tree-read test comes FIRST, and the
 * layout-forcing visibility check runs only on the handful that already matched - the reverse
 * order forced a reflow per element, thousands of times, at exactly the wrong moment.
 */
function findTrainHeadings(root: ParentNode): HTMLElement[] {
  const scan = root.querySelectorAll<HTMLElement>(
    'h1, h2, h3, h4, h5, h6, a, button, span, div, p, strong'
  );
  const hits: HTMLElement[] = [];

  for (const el of Array.from(scan)) {
    // 1. Cheap: pure tree read, no layout.
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 4 || text.length > 120) continue;
    if (!PATTERNS.trainHeading.test(text)) continue;

    // 2. Reject wrappers that also swallow the live "N users are trying to book" line.
    const lower = normText(text);
    if (TEXT.noisyCounters.some((noise) => lower.includes(noise))) continue;

    // 3. Only now the expensive check.
    if (!isVisible(el)) continue;

    // 4. Keep only the innermost element carrying this exact heading.
    if (hits.some((existing) => el.contains(existing))) continue;
    hits.push(el);
  }
  return hits;
}

function parseFare(cardText: string): number | null {
  const match = PATTERNS.fare.exec(cardText);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function parseSeatsLeft(cardText: string): number | null {
  const match = PATTERNS.seatsLeft.exec(cardText);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function mapAvailability(seatsLeft: number | null, targetSeats: number): Availability {
  // Never guess. An unparseable count is UNKNOWN, not "probably fine".
  if (seatsLeft === null) return 'UNKNOWN';
  if (seatsLeft <= 0) return 'SOLD_OUT';
  if (seatsLeft < targetSeats) return 'LIMITED';
  return 'AVAILABLE';
}

/** Parse the class cards inside one expanded train row. */
export function parseClassCards(container: HTMLElement, targetSeats: number): ClassOffer[] {
  const candidates = Array.from(
    container.querySelectorAll<HTMLElement>('div, li, td, section, article')
  ).filter((el) => {
    // Cheap text tests first; the layout-forcing visibility check only on survivors.
    const text = elementText(el);
    if (!text.includes(TEXT.availableTickets)) return false;
    if (!TRAVEL_CLASSES.some((token) => text.includes(normText(token)))) return false;
    return isVisible(el);
  });

  // Every ancestor of a card also contains the card's text, so the raw candidate list is
  // full of wrappers - the row, the grid, the page. A real card is a match that contains no
  // other match. This has to be decided across the whole set, not while iterating: document
  // order visits the wrappers first, when the inner matches do not exist yet.
  const cards = candidates.filter(
    (el) => !candidates.some((other) => other !== el && el.contains(other))
  );

  return cards.map((card) => {
    const text = elementText(card);

    // The class token is whichever known token appears; longest first so AC_CHAIR is not
    // shadowed by a shorter token that happens to be a substring.
    const className =
      [...TRAVEL_CLASSES]
        .sort((a, b) => b.length - a.length)
        .find((token) => text.includes(normText(token))) ?? 'UNKNOWN';

    const seatsLeft = parseSeatsLeft(text);
    const bookNow = findByText(card, [...RESULTS.bookNow.text!], { tags: ['button', 'a'], clickable: true })[0] ?? null;

    // Fare is read from the text before the availability block so the count is not mistaken
    // for a price.
    const fareSlice = text.split(TEXT.availableTickets)[0] ?? text;

    return {
      className,
      fare: parseFare(fareSlice.replace(normText(className), '')),
      seatsLeft,
      availability: mapAvailability(seatsLeft, targetSeats),
      hasBookNow: !!bookNow,
      element: card,
      bookNowElement: bookNow,
    } satisfies ClassOffer;
  });
}

/** Parse every train row currently rendered. */
export function parseTrainRows(targetSeats: number, root: ParentNode = document): TrainResult[] {
  const headings = findTrainHeadings(root);

  return headings.map((heading) => {
    const container = isolatedAncestor(heading, headings);
    const raw = (heading.innerText ?? heading.textContent ?? '').replace(/\s+/g, ' ').trim();
    const match = PATTERNS.trainHeading.exec(raw);

    const classes = parseClassCards(container, targetSeats);

    return {
      name: (match?.[1] ?? raw).trim(),
      number: match?.[2] ?? null,
      rawLabel: raw,
      // A row is expanded when its class cards are actually rendered.
      expanded: classes.length > 0,
      departure: null,
      arrival: null,
      duration: null,
      classes,
      element: container,
      headerElement: heading,
    } satisfies TrainResult;
  });
}

/** Loose match so the user can type "Subarna" and hit "SUBARNA EXPRESS (702)". */
export function matchesTrainPreference(train: TrainResult, preference: string): boolean {
  const wanted = normText(preference);
  if (!wanted) return false;
  const name = normText(train.name);
  const label = normText(train.rawLabel);
  return name === wanted || label === wanted || name.includes(wanted) || (train.number ?? '') === wanted.trim();
}

/** A class offer is worth clicking only if the site itself says so. */
export function isBookable(offer: ClassOffer): boolean {
  return offer.hasBookNow && offer.availability !== 'SOLD_OUT';
}

/**
 * The "No train found for selected dates or cities" state.
 *
 * Returns the matched phrase, or null. Before the booking window opens the site answers a
 * perfectly valid search with this page, so at 08:00:00 it means "a moment too early", not
 * "no such route" - the caller retries rather than giving up.
 */
export function findNoResultsNotice(root: ParentNode = document): string | null {
  const candidates = root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, p, div, span, strong');

  for (const el of Array.from(candidates)) {
    if (el.children.length > 1) continue;
    const text = elementText(el);
    if (!text || text.length > 160) continue;
    const hit = NO_RESULTS.textHints.find((hint) => text.includes(hint));
    if (hit && isVisible(el)) return hit;
  }
  return null;
}
