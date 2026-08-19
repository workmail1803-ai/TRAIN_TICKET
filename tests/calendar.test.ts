import { describe, expect, it, beforeEach } from 'vitest';
import {
  describeShape,
  findCalendarHeader,
  findCalendarNav,
  findCalendarPopup,
  findDateFieldIcon,
  findDayCells,
  pickDate,
} from '@/content/form-filler';

/**
 * Regression tests for a live failure: matching the picker on `[class*="calendar"]` resolved in
 * 4 ms to the little calendar ICON inside the date field. The header was then unreadable and no
 * day cells existed, so arming failed with "Day 18 not present in the calendar".
 *
 * The fixture below reproduces that trap - a decoy icon whose class contains "calendar", sitting
 * next to the real picker.
 */

/** August 2026 as observed: 16-25 selectable, everything else greyed. */
function augustCalendar(): string {
  const week = (days: Array<[number, boolean, string?]>) =>
    `<tr>${days
      .map(([n, enabled, extra]) => `<td class="day ${enabled ? '' : 'disabled'} ${extra ?? ''}">${n}</td>`)
      .join('')}</tr>`;

  return `
    <div class="datepicker-dropdown">
      <table>
        <thead>
          <tr>
            <th class="prev">‹</th>
            <th class="datepicker-switch" colspan="5">August 2026</th>
            <th class="next">›</th>
          </tr>
          <tr>
            <th>Su</th><th>Mo</th><th>Tu</th><th>We</th><th>Th</th><th>Fr</th><th>Sa</th>
          </tr>
        </thead>
        <tbody>
          ${week([[26, false, 'old'], [27, false, 'old'], [28, false, 'old'], [29, false, 'old'], [30, false, 'old'], [31, false, 'old'], [1, false]])}
          ${week([[2, false], [3, false], [4, false], [5, false], [6, false], [7, false], [8, false]])}
          ${week([[9, false], [10, false], [11, false], [12, false], [13, false], [14, false], [15, false]])}
          ${week([[16, true], [17, true], [18, true], [19, true], [20, true], [21, true], [22, true]])}
          ${week([[23, true], [24, true], [25, true], [26, false], [27, false], [28, false], [29, false]])}
          ${week([[30, false], [31, false], [1, false, 'new'], [2, false, 'new'], [3, false, 'new'], [4, false, 'new'], [5, false, 'new']])}
        </tbody>
      </table>
    </div>`;
}

/** The date field, complete with the decoy icon that caused the original bug. */
function dateField(open: boolean): string {
  return `
    <div class="form-group">
      <label>Date of Journey</label>
      <div class="input-wrap">
        <input placeholder="Pick a date" />
        <i class="fa fa-calendar calendar-icon"></i>
      </div>
      ${open ? augustCalendar() : ''}
    </div>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('calendar popup discovery', () => {
  it('finds nothing when the picker is closed, even though a "calendar" icon exists', () => {
    document.body.innerHTML = dateField(false);
    expect(document.querySelector('[class*="calendar"]')).not.toBeNull(); // the decoy is there
    expect(findCalendarPopup()).toBeNull(); // but it is not a calendar
  });

  it('finds the real picker once it opens, via the Su..Sa weekday row', () => {
    document.body.innerHTML = dateField(true);
    const calendar = findCalendarPopup();
    expect(calendar).not.toBeNull();
    expect(calendar!.textContent).toContain('August 2026');
  });

  it('returns the innermost container, not an outer wrapper', () => {
    document.body.innerHTML = `<div id="outer"><div id="mid">${dateField(true)}</div></div>`;
    const calendar = findCalendarPopup()!;
    expect(calendar.id).not.toBe('outer');
    expect(calendar.id).not.toBe('mid');
  });
});

describe('calendar internals', () => {
  beforeEach(() => {
    document.body.innerHTML = dateField(true);
  });

  it('reads the month/year header', () => {
    const calendar = findCalendarPopup()!;
    const header = findCalendarHeader(calendar);
    expect(header?.textContent?.trim()).toBe('August 2026');
  });

  it('finds both navigation arrows', () => {
    const calendar = findCalendarPopup()!;
    expect(findCalendarNav(calendar, 'prev')?.textContent).toBe('‹');
    expect(findCalendarNav(calendar, 'next')?.textContent).toBe('›');
  });

  it('finds day cells but not the weekday labels or the header', () => {
    const calendar = findCalendarPopup()!;
    const days = findDayCells(calendar);
    const texts = days.map((d) => d.textContent);

    expect(texts).not.toContain('Su');
    expect(texts).not.toContain('August 2026');
    expect(texts).toContain('18');
    expect(days.length).toBe(42); // six full weeks
  });

  it('locates day 18 as selectable — the case that originally failed', () => {
    const calendar = findCalendarPopup()!;
    const eighteens = findDayCells(calendar).filter((c) => c.textContent?.trim() === '18');
    expect(eighteens).toHaveLength(1);
    expect(eighteens[0]!.className).not.toContain('disabled');
  });

  it('sees day 12 as present but disabled, so it is never clicked', () => {
    const calendar = findCalendarPopup()!;
    const twelve = findDayCells(calendar).find((c) => c.textContent?.trim() === '12')!;
    expect(twelve.className).toContain('disabled');
  });

  it('distinguishes the two "26"s — one greyed from July, one out of window', () => {
    const calendar = findCalendarPopup()!;
    const twentySixes = findDayCells(calendar).filter((c) => c.textContent?.trim() === '26');
    expect(twentySixes).toHaveLength(2);
    expect(twentySixes.every((c) => c.className.includes('disabled'))).toBe(true);
  });
});

describe('header parsing across layouts', () => {
  /** A div-based picker, i.e. one where the weekday row is its own element. */
  function divCalendar(headerHtml: string): string {
    const days = Array.from({ length: 31 }, (_, i) => `<span class="day">${i + 1}</span>`).join('');
    return `
      <div class="dp">
        ${headerHtml}
        <div class="wk">
          <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
        </div>
        <div class="days">${days}</div>
      </div>`;
  }

  it('does not resolve to the weekday strip, which has no header or days', () => {
    document.body.innerHTML = divCalendar('<div class="head">August 2026</div>');
    const calendar = findCalendarPopup()!;
    expect(calendar.className).toBe('dp');
    expect(findDayCells(calendar)).toHaveLength(31);
  });

  it('reads a header split across two elements with no separator', () => {
    // Renders as "August2026" — this defeated the original space-anchored parser.
    document.body.innerHTML = divCalendar('<div class="head"><span>August</span><span>2026</span></div>');
    const calendar = findCalendarPopup()!;
    expect(findCalendarHeader(calendar)).not.toBeNull();
  });

  it('reads an abbreviated month header', () => {
    document.body.innerHTML = divCalendar('<div class="head">Aug 2026</div>');
    const calendar = findCalendarPopup()!;
    expect(findCalendarHeader(calendar)?.textContent?.trim()).toBe('Aug 2026');
  });

  it('reads a numeric month header without mistaking the year for the month', () => {
    document.body.innerHTML = divCalendar('<div class="head">08/2026</div>');
    const calendar = findCalendarPopup()!;
    expect(findCalendarHeader(calendar)?.textContent?.trim()).toBe('08/2026');
  });
});

describe('opening the picker', () => {
  /**
   * The live failure: clicking the field did nothing at all. This fixture reproduces a picker
   * wired to the icon only, which is what the escalation exists to handle.
   */
  function iconOnlyPicker(): HTMLInputElement {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Date of Journey</label>
        <div class="input-wrap">
          <input id="d" placeholder="Pick a date" readonly />
          <i class="fa fa-calendar calendar-icon"></i>
        </div>
        <div id="host"></div>
      </div>`;

    const input = document.getElementById('d') as HTMLInputElement;
    const icon = document.querySelector('.calendar-icon') as HTMLElement;
    const host = document.getElementById('host') as HTMLElement;

    // Only the icon opens it. Clicking the field is deliberately inert.
    icon.addEventListener('click', () => {
      host.innerHTML = augustCalendar();
      host.querySelectorAll('td.day:not(.disabled)').forEach((cell) => {
        cell.addEventListener('click', () => {
          input.value = `${cell.textContent}-Aug-2026`;
          host.innerHTML = '';
        });
      });
    });

    return input;
  }

  it('finds the icon trigger beside the field', () => {
    const input = iconOnlyPicker();
    const icon = findDateFieldIcon(input);
    expect(icon?.className).toContain('calendar-icon');
  });

  it('opens via the icon when clicking the field does nothing, and commits the date', async () => {
    const input = iconOnlyPicker();

    const result = await pickDate(input, '2026-08-18');

    expect(result.ok).toBe(true);
    expect(result.committed).toBe('18-Aug-2026');
  });

  it('refuses a date the calendar cannot offer rather than clicking something else', async () => {
    const input = iconOnlyPicker();

    // 12 Aug is rendered but disabled — outside the site's rolling window.
    const result = await pickDate(input, '2026-08-12');

    expect(result.ok).toBe(false);
    expect(result.note).toContain('disabled');
    expect(input.value).toBe('');
  });

  it('reports the field markup when no trigger works, so it can be fixed precisely', async () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Date of Journey</label>
        <input id="d" placeholder="Pick a date" />
      </div>`;
    const input = document.getElementById('d') as HTMLInputElement;

    const result = await pickDate(input, '2026-08-18');
    expect(result.ok).toBe(false);
    expect(result.note).toContain('Could not open the date picker');
  });

  it('sketches markup structurally, with no text content', () => {
    const input = iconOnlyPicker();
    const shape = describeShape(input.closest('.form-group') as HTMLElement);

    expect(shape).toContain('div.form-group');
    expect(shape).toContain('input#d');
    expect(shape).toContain('i.fa.fa-calendar.calendar-icon');
    expect(shape).not.toContain('Date of Journey');
  });
});
