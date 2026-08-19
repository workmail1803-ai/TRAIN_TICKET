import { AUTOCOMPLETE, CALENDAR_DISABLED_HINTS } from '@/selectors/railway-selectors';
import { findAll, isEnabled, isVisible, normText } from './element-finder';
import { realClick } from './dom-engine';
import { waitFor, waitForQuiet } from '@/utils/wait';
import { logger } from '@/utils/logger';

/**
 * Writing to fields in a way frameworks actually notice, and always verifying by reading
 * the value back. A field that "looks" filled but was never committed is the classic
 * silent failure in this kind of automation, and it is unrecoverable at 08:00.
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

/**
 * React (and other frameworks) install their own `value` setter on the element instance and
 * track the last value they wrote. Assigning `el.value = x` directly is invisible to them.
 * Calling the *prototype* setter updates the DOM in a way their onChange handler picks up.
 */
export function setNativeValue(element: HTMLElement, value: string): void {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;

  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    (element as HTMLInputElement).value = value;
  }
}

function fireInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/** Keyboard events some autocomplete widgets require before they will open. */
function fireKeyEvents(element: HTMLElement, key: string): void {
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new KeyboardEvent('keydown', init));
  element.dispatchEvent(new KeyboardEvent('keyup', init));
}

export interface FillResult {
  ok: boolean;
  committed: string;
  note?: string;
}

/**
 * Fill a text input and confirm the value stuck.
 *
 * If an autocomplete list opens, the typed text alone is usually NOT accepted by the site -
 * a suggestion has to be chosen. That list's markup is UNVERIFIED here, so this handles it
 * defensively: look for an opened list, click the exact match if one is found, and either
 * way verify the field afterwards.
 */
export async function fillStationField(
  element: HTMLInputElement,
  value: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<FillResult> {
  const timeoutMs = options.timeoutMs ?? 2500;

  element.focus({ preventScroll: true });
  setNativeValue(element, '');
  fireInputEvents(element);

  setNativeValue(element, value);
  fireInputEvents(element);
  fireKeyEvents(element, value.slice(-1) || 'a');

  // Give an autocomplete a brief, event-driven chance to appear. Absence is fine.
  const suggestion = await waitFor(
    () => {
      const lists = findAll(AUTOCOMPLETE.container, { visible: true });
      for (const list of lists) {
        if (!isVisible(list)) continue;
        const items = Array.from(
          list.querySelectorAll('li, div[role="option"], [role="option"], button, a')
        ).filter((el): el is HTMLElement => el instanceof HTMLElement && isVisible(el));

        const exact = items.find((el) => normText(el.textContent) === normText(value));
        if (exact) return exact;

        const partial = items.find((el) => normText(el.textContent).includes(normText(value)));
        if (partial) return partial;
      }
      return null;
    },
    { what: 'station suggestion', timeoutMs: 700, scope: document.body, pollMs: 50 }
  ).catch(() => null);

  if (suggestion) {
    realClick(suggestion);
    logger.info(`Picked station suggestion for "${value}"`);
  }

  element.dispatchEvent(new Event('blur', { bubbles: true }));

  // Read back. The site may normalise the text ("Dhaka" -> "Dhaka (DHK)"), so accept a
  // value that contains what we asked for.
  const committed = await waitFor(
    () => {
      const current = element.value ?? '';
      return normText(current).includes(normText(value)) ? current : null;
    },
    { what: `station field committed "${value}"`, timeoutMs, scope: element.parentElement ?? document.body, pollMs: 60 }
  ).catch(() => null);

  if (committed !== null) return { ok: true, committed };

  return {
    ok: false,
    committed: element.value ?? '',
    note: `Field did not accept "${value}". If this site requires choosing from a dropdown, the suggestion list was not found - its markup is UNVERIFIED.`,
  };
}

/** Set a native <select> by matching option text or value. */
export function selectOption(
  select: HTMLSelectElement,
  match: (optionText: string, optionValue: string) => boolean
): FillResult {
  const options = Array.from(select.options);
  const target = options.find((o) => match(normText(o.textContent), o.value));

  if (!target) {
    return {
      ok: false,
      committed: select.value,
      note: `No matching option. Available: ${options.map((o) => o.textContent?.trim()).join(' | ')}`,
    };
  }

  setNativeValue(select, target.value);
  select.selectedIndex = target.index;
  fireInputEvents(select);

  const ok = select.value === target.value;
  return { ok, committed: select.value, ...(ok ? {} : { note: 'Select did not retain the value' }) };
}

/** Close a popup/overlay the way a user would: Escape, then a click outside it. */
export async function dismissPopup(popup: HTMLElement | null, anchor?: HTMLElement): Promise<boolean> {
  if (!popup || !popup.isConnected || !isVisible(popup)) return true;

  const escape: KeyboardEventInit = { key: 'Escape', bubbles: true, cancelable: true, composed: true };
  (anchor ?? document.body).dispatchEvent(new KeyboardEvent('keydown', escape));

  if (!popup.isConnected || !isVisible(popup)) return true;

  // Most pickers close on an outside mousedown rather than a click.
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

  const closed = await waitFor(() => (!popup.isConnected || !isVisible(popup) ? true : null), {
    what: 'popup dismissed',
    timeoutMs: 800,
    scope: popup.parentElement ?? document.body,
    pollMs: 60,
  }).catch(() => false);

  return closed === true;
}

/**
 * Choose a value from a dropdown, tapping it open first.
 *
 * A native <select> does not need opening - setting .value and firing change is enough - but
 * a control that merely *looks* native does, and clicking a real <select> first is harmless.
 * So this always taps, then tries the native path, then falls back to driving a custom
 * widget's option list. Either way it verifies what actually got committed.
 */
export async function selectValue(
  host: HTMLElement,
  wanted: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<FillResult> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const target = normText(wanted);

  realClick(host);

  if (host instanceof HTMLSelectElement) {
    const result = selectOption(host, (text, value) => {
      const t = normText(text);
      const v = normText(value);
      return t === target || v === target || t.includes(target);
    });
    if (result.ok) {
      await dismissPopup(null);
      return result;
    }
    logger.warn(`Native select path failed for "${wanted}" (${result.note}) - trying the widget path`);
  }

  // Widget path: an option list rendered somewhere outside the control itself.
  const option = await waitFor(
    () => {
      const candidates = document.querySelectorAll<HTMLElement>(
        'li, [role="option"], option, div, span, a, button'
      );
      for (const el of Array.from(candidates)) {
        if (el.children.length > 0) continue;
        if (host.contains(el) && !(host instanceof HTMLSelectElement)) continue;
        if (!isVisible(el)) continue;
        if (normText(el.textContent) === target) return el;
      }
      return null;
    },
    {
      what: `dropdown option "${wanted}"`,
      timeoutMs,
      scope: document.body,
      signal: options.signal,
      pollMs: 60,
    }
  ).catch(() => null);

  if (!option) {
    return {
      ok: false,
      committed: host instanceof HTMLSelectElement ? host.value : normText(host.textContent),
      note: `Could not find an option reading "${wanted}" after tapping the control open.`,
    };
  }

  realClick(option);

  const committed = await waitFor(
    () => {
      const shown =
        host instanceof HTMLSelectElement
          ? normText(host.options[host.selectedIndex]?.textContent ?? host.value)
          : normText(host.textContent);
      return shown.includes(target) ? shown : null;
    },
    {
      what: `dropdown committed "${wanted}"`,
      timeoutMs,
      scope: host.parentElement ?? document.body,
      pollMs: 60,
    }
  ).catch(() => null);

  if (committed === null) {
    return { ok: false, committed: normText(host.textContent), note: `Clicked "${wanted}" but the control did not update` };
  }
  return { ok: true, committed };
}

/**
 * Does a committed date field actually show the date we asked for?
 *
 * The observed format is "18-Aug-2026", but this deliberately accepts any arrangement of the
 * same three parts rather than hard-coding one layout. Booking the wrong day is unrecoverable
 * and already paid for, so this check is strict about the date and lax about the formatting.
 */
export function dateValueMatches(value: string, isoDate: string): boolean {
  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!year || !month || !day) return false;

  const text = normText(value);
  if (!text.includes(String(year))) return false;

  const withoutYear = text.replace(new RegExp(String(year), 'g'), '');

  const abbr = MONTH_ABBR[month - 1]!;
  const full = MONTHS[month - 1]!;
  const hasMonth =
    withoutYear.includes(full) ||
    withoutYear.includes(abbr) ||
    new RegExp(`\\b0?${month}\\b`).test(withoutYear.replace(new RegExp(`\\b0?${day}\\b`), ''));
  if (!hasMonth) return false;

  return new RegExp(`\\b0?${day}\\b`).test(withoutYear);
}

// ---------------------------------------------------------------------------
// Date picker
// ---------------------------------------------------------------------------

const WEEKDAY_PREFIXES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

function leafElements(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.children.length === 0
  );
}

/**
 * Find the calendar popup by what it contains, not by its class.
 *
 * LEARNED FROM A LIVE FAILURE: matching on `[class*="calendar"]` resolved in 4 ms to the little
 * calendar ICON inside the date field, so the header was unreadable and no day cells existed.
 * A weekday header row (Su Mo Tu We Th Fr Sa) is something only the real calendar has, and it
 * is one of the few things the screenshots actually prove.
 */
export function findCalendarPopup(root: ParentNode = document): HTMLElement | null {
  const containers = Array.from(root.querySelectorAll<HTMLElement>('div, table, section, aside, ul, tbody'));

  const byWeekdayRow: HTMLElement[] = [];
  const byDayGrid: HTMLElement[] = [];

  for (const el of containers) {
    if (!isVisible(el)) continue;
    const leaves = leafElements(el, 'th, td, span, div, li, abbr, p, button, a').map((n) =>
      normText(n.textContent)
    );

    const labels = new Set(leaves.map((t) => t.slice(0, 2)));
    const dayCount = leaves.filter(
      (t) => /^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 31
    ).length;

    // Both halves are required. Matching the weekday row alone would resolve to the weekday
    // STRIP when that strip is its own element - a container with no header and no day cells,
    // which is useless. A calendar has weekday labels AND a month of days.
    if (WEEKDAY_PREFIXES.every((day) => labels.has(day)) && dayCount >= 20) {
      byWeekdayRow.push(el);
      continue;
    }

    // Fallback for a picker that labels its columns differently: a dense grid of day numbers.
    // A month view always renders at least 28 of them.
    if (dayCount >= 28) byDayGrid.push(el);
  }

  // Innermost wins: every ancestor of the calendar also contains the weekday row.
  const pick = (matches: HTMLElement[]) =>
    matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)))[0] ?? null;

  return pick(byWeekdayRow) ?? pick(byDayGrid);
}

/**
 * The trigger next to a date input - typically a calendar icon. Some pickers bind their open
 * handler to this rather than to the field, so clicking the input alone does nothing.
 */
export function findDateFieldIcon(input: HTMLElement): HTMLElement | null {
  const looksLikeTrigger = (el: HTMLElement): boolean => {
    const signature = normText(
      [el.getAttribute('class') ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''].join(' ')
    );
    return /calendar|datepicker|date-?icon|\bicon\b/.test(signature);
  };

  let container: HTMLElement | null = input.parentElement;
  for (let depth = 0; container && depth < 3; depth++) {
    const matches = Array.from(
      container.querySelectorAll<HTMLElement>('i, span, button, img, svg, a, div')
    ).filter((el) => el !== input && !el.contains(input) && isVisible(el) && looksLikeTrigger(el));
    if (matches[0]) return matches[0];
    container = container.parentElement;
  }

  const sibling = input.nextElementSibling;
  return sibling instanceof HTMLElement && isVisible(sibling) ? sibling : null;
}

/**
 * Structural sketch of an element's subtree - tags, ids and classes, no text.
 *
 * Logged when the picker cannot be opened, so the markup can be fixed precisely instead of
 * guessed at. Deliberately excludes text content so nothing personal reaches the log.
 */
export function describeShape(root: HTMLElement, limit = 25): string {
  const describe = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
    return `${el.tagName.toLowerCase()}${id}${cls.length ? '.' + cls.join('.') : ''}`;
  };

  const parts = [describe(root)];
  for (const el of Array.from(root.querySelectorAll('*')).slice(0, limit)) parts.push(describe(el));
  return parts.join(' > ');
}

/**
 * Open the date picker, trying each plausible trigger and verifying after every attempt.
 *
 * LEARNED FROM A LIVE FAILURE: clicking the input did nothing on this site. Rather than guess
 * which trigger the widget listens to, escalate through them and stop at whichever works. The
 * winning strategy is logged so it is known for next time.
 */
async function openDatePicker(
  input: HTMLInputElement,
  signal?: AbortSignal
): Promise<HTMLElement | null> {
  const keyEvent = (key: string): KeyboardEventInit => ({
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
  });

  const strategies: Array<{ name: string; run: () => void }> = [
    { name: 'click the field', run: () => realClick(input) },
    {
      name: 'focus the field',
      run: () => {
        input.focus({ preventScroll: true });
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
        input.dispatchEvent(new FocusEvent('focus', { bubbles: false, composed: true }));
      },
    },
    {
      name: 'click the calendar icon',
      run: () => {
        const icon = findDateFieldIcon(input);
        if (icon) realClick(icon);
      },
    },
    {
      name: 'ArrowDown in the field',
      run: () => {
        input.focus({ preventScroll: true });
        input.dispatchEvent(new KeyboardEvent('keydown', keyEvent('ArrowDown')));
        input.dispatchEvent(new KeyboardEvent('keyup', keyEvent('ArrowDown')));
      },
    },
  ];

  for (const strategy of strategies) {
    strategy.run();

    const calendar = await waitFor(() => findCalendarPopup(), {
      what: `calendar via ${strategy.name}`,
      timeoutMs: 700,
      scope: document.body,
      signal,
      pollMs: 50,
    }).catch(() => null);

    if (calendar) {
      logger.info(`Calendar opened by: ${strategy.name}`);
      return calendar;
    }
    logger.info(`Calendar did not open by: ${strategy.name}`);
  }

  return null;
}

/** The month/year label, e.g. "August 2026". Found by shape, anywhere inside the popup. */
export function findCalendarHeader(calendar: HTMLElement): HTMLElement | null {
  const candidates = leafElements(calendar, 'th, div, span, a, button, h1, h2, h3, h4, p');
  for (const el of candidates) {
    if (parseCalendarHeader(el.textContent ?? '')) return el;
  }
  // Some pickers split month and year into siblings; fall back to a small container holding both.
  for (const el of Array.from(calendar.querySelectorAll<HTMLElement>('th, div, span'))) {
    if (el.children.length > 3) continue;
    if (parseCalendarHeader(el.textContent ?? '')) return el;
  }
  return null;
}

const ARROWS = {
  prev: ['‹', '«', '◄', '←', '<', 'prev', 'previous'],
  next: ['›', '»', '►', '→', '>', 'next'],
};

/** Month navigation arrow, by attribute hint, then glyph, then position around the header. */
export function findCalendarNav(calendar: HTMLElement, direction: 'prev' | 'next'): HTMLElement | null {
  const candidates = Array.from(
    calendar.querySelectorAll<HTMLElement>('a, button, span, div, th, i')
  ).filter((el) => isVisible(el));

  const word = direction === 'prev' ? /\b(prev|previous)\b/ : /\bnext\b/;
  for (const el of candidates) {
    const signature = normText(
      [el.className?.toString?.() ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''].join(' ')
    );
    if (word.test(signature)) return el;
  }

  for (const el of candidates) {
    if (el.children.length > 0) continue;
    const text = normText(el.textContent);
    if (text.length <= 4 && ARROWS[direction].some((glyph) => text === normText(glyph))) return el;
  }

  // Positional fallback: the arrows sit either side of the month label.
  const header = findCalendarHeader(calendar);
  const row = header?.parentElement;
  if (row) {
    const siblings = Array.from(row.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== header && isVisible(el)
    );
    if (siblings.length >= 2) return direction === 'prev' ? siblings[0]! : siblings[siblings.length - 1]!;
  }
  return null;
}

/** Day cells: leaf elements inside the popup whose entire text is a day number. */
export function findDayCells(calendar: HTMLElement): HTMLElement[] {
  return leafElements(calendar, 'td, div, span, button, a, li').filter((el) => {
    const text = normText(el.textContent);
    if (!/^\d{1,2}$/.test(text)) return false;
    const value = Number(text);
    return value >= 1 && value <= 31;
  });
}

/**
 * Read a month and year out of a calendar header.
 *
 * Tolerant by design. The first version required exactly "August 2026" with a space, and
 * reported the header unreadable on the live site - a header split across two spans yields
 * "August2026" with no separator, which also defeats a `\b`-anchored year match. Accepts full
 * names, abbreviations, and numeric months, in any arrangement.
 */
function parseCalendarHeader(text: string): { month: number; year: number } | null {
  const lower = normText(text);

  const yearMatch = /(?:19|20)\d{2}/.exec(lower);
  if (!yearMatch) return null;
  const year = Number(yearMatch[0]);

  let monthIdx = MONTHS.findIndex((month) => lower.includes(month));

  if (monthIdx < 0) {
    monthIdx = MONTH_ABBR.findIndex((abbr) => new RegExp(`\\b${abbr}`).test(lower));
  }

  if (monthIdx < 0) {
    // Numeric month, e.g. "08/2026" or "2026-08". Remove the year first so its digits cannot
    // be mistaken for the month.
    const withoutYear = lower.replace(String(year), ' ');
    const numeric = /(?:^|\D)(0?[1-9]|1[0-2])(?:\D|$)/.exec(withoutYear);
    if (!numeric?.[1]) return null;
    monthIdx = Number(numeric[1]) - 1;
  }

  return { month: monthIdx + 1, year };
}

function dayCellIsSelectable(cell: HTMLElement): boolean {
  if (!isEnabled(cell)) return false;
  const cls = normText(cell.className?.toString?.() ?? '');
  // "old"/"new" mark days belonging to the adjacent month; the rest mark out-of-window days.
  if (CALENDAR_DISABLED_HINTS.some((hint) => cls.split(/\s+/).includes(hint))) return false;
  if (cell.getAttribute('aria-disabled') === 'true') return false;
  return true;
}

/**
 * Choose a date through the site's own calendar widget.
 *
 * The observed widget only enables a rolling window (15-25 Aug when captured on 15 Aug,
 * i.e. today + 10 days). Disabled cells are never clicked - if the requested date is not
 * selectable this throws, which is the correct outcome: it means the date is not bookable
 * and pressing on would book the wrong day.
 */
export async function pickDate(
  input: HTMLInputElement,
  isoDate: string,
  options: { signal?: AbortSignal } = {}
): Promise<FillResult> {
  const [yearStr, monthStr, dayStr] = isoDate.split('-');
  const targetYear = Number(yearStr);
  const targetMonth = Number(monthStr);
  const targetDay = Number(dayStr);

  if (!targetYear || !targetMonth || !targetDay) {
    return { ok: false, committed: input.value, note: `Bad date "${isoDate}", expected yyyy-mm-dd` };
  }

  const calendar = await openDatePicker(input, options.signal);

  if (!calendar) {
    // Log the field's markup shape so the real trigger can be identified rather than guessed.
    const wrapper = input.closest('div, form, fieldset') as HTMLElement | null;
    if (wrapper) logger.warn(`Date field markup: ${describeShape(wrapper)}`);

    return {
      ok: false,
      committed: input.value,
      note:
        'Could not open the date picker. Tried clicking the field, focusing it, clicking the ' +
        'calendar icon, and ArrowDown. See the activity log for the field markup.',
    };
  }

  // Navigate to the target month. Bounded, so a broken arrow cannot spin forever.
  for (let hop = 0; hop < 24; hop++) {
    const headerEl = findCalendarHeader(calendar);
    const header = headerEl ? parseCalendarHeader(headerEl.textContent ?? '') : null;

    if (!header) {
      // Not fatal: the final read-back below verifies the committed date strictly, so a wrong
      // month surfaces as a refusal rather than a wrong booking.
      logger.warn('Calendar header unreadable - selecting from the visible month only');
      break;
    }

    const diff = (targetYear - header.year) * 12 + (targetMonth - header.month);
    if (diff === 0) break;

    const arrow = findCalendarNav(calendar, diff > 0 ? 'next' : 'prev');
    if (!arrow) {
      return {
        ok: false,
        committed: input.value,
        note: `Calendar is on ${header.month}/${header.year} but no ${diff > 0 ? 'next' : 'prev'} arrow was found`,
      };
    }
    realClick(arrow);
    await waitForQuiet(calendar, 80, { what: 'calendar month change', timeoutMs: 2000 }).catch(
      () => undefined
    );
  }

  const cells = findDayCells(calendar).filter(
    (cell) => normText(cell.textContent) === String(targetDay)
  );
  const selectable = cells.find(dayCellIsSelectable);

  if (!selectable) {
    const visible = findDayCells(calendar).filter(dayCellIsSelectable).map((c) => c.textContent?.trim());
    return {
      ok: false,
      committed: input.value,
      note:
        cells.length === 0
          ? `Day ${targetDay} not present in the calendar. Selectable days shown: ${visible.join(', ') || 'none'}`
          : `Day ${targetDay} is present but disabled - outside the site's bookable window. Selectable: ${visible.join(', ') || 'none'}`,
    };
  }

  realClick(selectable);

  const committed = await waitFor(() => (input.value?.trim() ? input.value : null), {
    what: 'date committed',
    timeoutMs: 2000,
    scope: input.parentElement ?? document.body,
    pollMs: 60,
  }).catch(() => null);

  if (committed === null) {
    return { ok: false, committed: input.value, note: 'Clicked the day but the input stayed empty' };
  }

  // The field is filled - but is it filled with the date we asked for? Booking the wrong day
  // is unrecoverable and already paid for, so this is checked rather than assumed.
  if (!dateValueMatches(committed, isoDate)) {
    return {
      ok: false,
      committed,
      note: `Calendar committed "${committed}" but ${isoDate} was requested. Refusing to continue with the wrong date.`,
    };
  }

  // The calendar overlays the SEARCH TRAINS button. If it stays open, the click at T0 lands
  // on the calendar instead of the button - so closing it is part of the job, not cosmetic.
  const closed = await dismissPopup(calendar, input);
  if (!closed) {
    logger.warn('Calendar did not close after picking the date - it may cover the search button');
  }

  return { ok: true, committed };
}
