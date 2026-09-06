import { describe, expect, it, beforeEach } from 'vitest';
import {
  claimSeats,
  classifySeats,
  pickCandidate,
  findSeatElements,
  parseCoachOption,
  parseCoaches,
  rankCoaches,
  readClaimedSeats,
  stateOf,
} from '@/content/seat-engine';
import { coachSelect, seatGrid, seatLegend } from './fixtures';
import type { CoachOption } from '@/types';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('coach option parsing', () => {
  it('extracts the code and the free-seat count from the option text', () => {
    expect(parseCoachOption('JHA - 2 Seat(s)', 'JHA')).toEqual({
      code: 'JHA',
      freeSeats: 2,
      value: 'JHA',
      rawLabel: 'JHA - 2 Seat(s)',
    });
  });

  it('handles zero and multi-digit counts', () => {
    expect(parseCoachOption('KHA - 0 Seat(s)', 'KHA')?.freeSeats).toBe(0);
    expect(parseCoachOption('SCHA - 27 Seat(s)', 'SCHA')?.freeSeats).toBe(27);
  });

  it('returns null rather than guessing on unexpected text', () => {
    expect(parseCoachOption('Select a coach', '')).toBeNull();
    expect(parseCoachOption('KHA', 'KHA')).toBeNull();
  });

  it('reads every coach from the select in one pass, no clicks needed', () => {
    document.body.innerHTML = coachSelect();
    const select = document.getElementById('coach') as HTMLSelectElement;
    const coaches = parseCoaches(select);

    expect(coaches).toHaveLength(8);
    expect(coaches.map((c) => c.code)).toEqual(['KHA', 'GA', 'GHA', 'UMA', 'CHA', 'SCHA', 'JA', 'JHA']);
    expect(coaches.find((c) => c.code === 'JHA')?.freeSeats).toBe(2);
    expect(coaches.filter((c) => c.freeSeats > 0)).toHaveLength(1);
  });
});

describe('coach ranking', () => {
  const coaches: CoachOption[] = [
    { code: 'KHA', freeSeats: 0, value: 'KHA', rawLabel: '' },
    { code: 'GA', freeSeats: 2, value: 'GA', rawLabel: '' },
    { code: 'GHA', freeSeats: 6, value: 'GHA', rawLabel: '' },
    { code: 'JHA', freeSeats: 4, value: 'JHA', rawLabel: '' },
    { code: 'CHA', freeSeats: 1, value: 'CHA', rawLabel: '' },
  ];

  it('prefers the roomiest coach that fits the whole party', () => {
    // Roomiest, not smallest-sufficient: slack is what makes four seats in a row possible and
    // survives a seat being taken concurrently.
    const ranked = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT');
    expect(ranked[0]!.code).toBe('GHA'); // 6 free
    expect(ranked[1]!.code).toBe('JHA'); // 4 free, also fits
  });

  it('still offers the smaller coaches so a split can reach the target', () => {
    const ranked = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT');
    expect(ranked.map((c) => c.code)).toEqual(['GHA', 'JHA', 'GA', 'CHA']);
    expect(ranked.some((c) => c.code === 'KHA')).toBe(false); // empty coach never queued
  });

  it('SINGLE_ONLY refuses to split', () => {
    const ranked = rankCoaches(coaches, 4, 'SINGLE_ONLY');
    expect(ranked.map((c) => c.code)).toEqual(['GHA', 'JHA']);
  });

  it('ANY simply takes the roomiest first', () => {
    const ranked = rankCoaches(coaches, 4, 'ANY');
    expect(ranked.map((c) => c.code)).toEqual(['GHA', 'JHA', 'GA', 'CHA']);
  });

  it('returns nothing when every coach is empty', () => {
    const empty = coaches.map((c) => ({ ...c, freeSeats: 0 }));
    expect(rankCoaches(empty, 4, 'PREFER_SINGLE_ALLOW_SPLIT')).toHaveLength(0);
  });

  describe('named coach preference', () => {
    it('puts the preferred coach first when it has seats', () => {
      const ranked = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT', 'GA');
      expect(ranked[0]!.code).toBe('GA'); // only 2 free — would otherwise rank third
    });

    it('falls through to the next available coach when the preferred one is full', () => {
      const ranked = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT', 'KHA'); // KHA has 0
      expect(ranked[0]!.code).toBe('GHA'); // normal ranking resumes: roomiest first
      expect(ranked.some((c) => c.code === 'KHA')).toBe(false);
    });

    it('is a preference, not a restriction — every other coach still follows', () => {
      const ranked = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT', 'GA');
      expect(ranked.map((c) => c.code)).toEqual(['GA', 'GHA', 'JHA', 'CHA']);
    });

    it('matches case-insensitively', () => {
      expect(rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT', 'gha')[0]!.code).toBe('GHA');
    });

    it('ignores a coach code that does not exist on this train', () => {
      const ranked = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT', 'ZZZ');
      expect(ranked.map((c) => c.code)).toEqual(['GHA', 'JHA', 'GA', 'CHA']);
    });

    it('leaves the order untouched when no preference is set', () => {
      const withPref = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT', '');
      const without = rankCoaches(coaches, 4, 'PREFER_SINGLE_ALLOW_SPLIT');
      expect(withPref.map((c) => c.code)).toEqual(without.map((c) => c.code));
    });

    it('still respects SINGLE_ONLY — a preferred coach too small is not promoted', () => {
      // GA has 2 free and the party needs 4, so SINGLE_ONLY excludes it entirely.
      const ranked = rankCoaches(coaches, 4, 'SINGLE_ONLY', 'GA');
      expect(ranked.map((c) => c.code)).toEqual(['GHA', 'JHA']);
    });
  });
});

describe('seat element discovery', () => {
  it('finds all 50 seats by their COACH-NUMBER label', () => {
    document.body.innerHTML = `<div id="panel">${seatLegend()}${seatGrid('KHA', 50)}</div>`;
    const panel = document.getElementById('panel') as HTMLElement;

    const seats = findSeatElements(panel);
    expect(seats).toHaveLength(50);
    expect(seats[0]!.textContent).toBe('KHA-1');
    expect(seats[49]!.textContent).toBe('KHA-50');
  });

  it('ignores the legend labels, which are not seats', () => {
    document.body.innerHTML = `<div id="panel">${seatLegend()}${seatGrid('JHA', 4)}</div>`;
    const panel = document.getElementById('panel') as HTMLElement;
    const labels = findSeatElements(panel).map((el) => el.textContent);

    expect(labels).toEqual(['JHA-1', 'JHA-2', 'JHA-3', 'JHA-4']);
    expect(labels).not.toContain('Available');
  });
});

/**
 * Regression tests for the live failure that claimed 1 seat from a coach advertising 20 free.
 * The old classifier grouped seats by class name and measured one representative per group, so
 * a whole grid could receive a single verdict.
 */
describe('per-seat classification', () => {
  const unusableLegend = { usable: false, colours: {} };

  it('classifies each seat individually, not one verdict per class group', () => {
    document.body.innerHTML = `
      <div id="panel">
        <button class="seat booked">DA-1</button>
        <button class="seat booked">DA-2</button>
        <button class="seat available">DA-3</button>
        <button class="seat booked">DA-4</button>
        <button class="seat available">DA-5</button>
      </div>`;
    const panel = document.getElementById('panel') as HTMLElement;

    const cells = classifySeats(panel, unusableLegend);
    const free = cells.filter((c) => c.state === 'AVAILABLE').map((c) => c.label);

    expect(cells).toHaveLength(5);
    expect(free).toEqual(['DA-3', 'DA-5']);
  });

  it('treats a disabled seat as booked regardless of anything else', () => {
    document.body.innerHTML = `
      <div id="panel"><button class="seat" disabled>DA-9</button></div>`;
    const panel = document.getElementById('panel') as HTMLElement;

    expect(classifySeats(panel, unusableLegend)[0]!.state).toBe('BOOKED');
  });

  it('reports UNKNOWN rather than guessing when nothing distinguishes the seats', () => {
    document.body.innerHTML = `
      <div id="panel">
        <button class="seat">DA-1</button><button class="seat">DA-2</button>
      </div>`;
    const panel = document.getElementById('panel') as HTMLElement;

    const cells = classifySeats(panel, unusableLegend);
    expect(cells.every((c) => c.state === 'UNKNOWN')).toBe(true);
  });

  it('does not double-count a seat whose label sits inside the button', () => {
    document.body.innerHTML = `
      <div id="panel"><button class="seat available"><span>DA-7</span></button></div>`;
    const panel = document.getElementById('panel') as HTMLElement;

    const cells = classifySeats(panel, unusableLegend);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.label).toBe('DA-7');
  });
});

/**
 * Losing a race for a seat is normal at 08:00. What matters is detecting it from the site's own
 * signal - the seat flipping to Booked or In Progress - rather than paying a full timeout.
 */
describe('race outcome signals', () => {
  const unusableLegend = { usable: false, colours: {} };

  function seat(className: string): HTMLElement {
    document.body.innerHTML = `<button class="${className}">DA-12</button>`;
    return document.querySelector('button') as HTMLElement;
  }

  it('reads a seat someone else took as BOOKED', () => {
    expect(stateOf(seat('seat booked'), unusableLegend)).toBe('BOOKED');
  });

  it('reads a seat someone else is holding as IN_PROGRESS', () => {
    expect(stateOf(seat('seat in-progress'), unusableLegend)).toBe('IN_PROGRESS');
  });

  it('reads our own successful claim as SELECTED', () => {
    expect(stateOf(seat('seat selected'), unusableLegend)).toBe('SELECTED');
  });

  it('reads a free seat as AVAILABLE', () => {
    expect(stateOf(seat('seat available'), unusableLegend)).toBe('AVAILABLE');
  });

  it('treats a disabled seat as BOOKED whatever its classes say', () => {
    document.body.innerHTML = `<button class="seat available" disabled>DA-12</button>`;
    const el = document.querySelector('button') as HTMLElement;
    expect(stateOf(el, unusableLegend)).toBe('BOOKED');
  });

  it('says UNKNOWN rather than guessing when nothing distinguishes it', () => {
    expect(stateOf(seat('seat'), unusableLegend)).toBe('UNKNOWN');
  });

  it('never offers an In Progress seat as a candidate — someone else is mid-claim', () => {
    document.body.innerHTML = `
      <div id="panel">
        <button class="seat available">DA-1</button>
        <button class="seat in-progress">DA-2</button>
        <button class="seat booked">DA-3</button>
        <button class="seat available">DA-4</button>
      </div>`;
    const panel = document.getElementById('panel') as HTMLElement;

    const free = classifySeats(panel, unusableLegend)
      .filter((c) => c.state === 'AVAILABLE')
      .map((c) => c.label);

    expect(free).toEqual(['DA-1', 'DA-4']);
  });
});

/**
 * Regression: a granted seat used to vanish from the count whenever the site's Seat Details
 * summary was empty — either because the panel could not be resolved, or because the table
 * lagged a beat behind the click. With the count stuck at zero the target was never reached, so
 * the loop kept claiming: it under-reported to the user AND could hold more seats than requested.
 */
describe('claiming without a Seat Details panel', () => {
  function grid(available: number, booked: number): HTMLElement {
    const seats = [];
    for (let i = 1; i <= available; i++) seats.push(`<button class="seat available">DA-${i}</button>`);
    for (let i = 1; i <= booked; i++) {
      seats.push(`<button class="seat booked">DA-${available + i}</button>`);
    }
    document.body.innerHTML = `<div id="panel"><div class="grid">${seats.join('')}</div></div>`;

    const panel = document.getElementById('panel') as HTMLElement;
    // The site marks a seat selected when the claim succeeds.
    panel.querySelectorAll('.seat.available').forEach((el) => {
      el.addEventListener('click', () => {
        (el as HTMLElement).className = 'seat selected';
      });
    });
    return panel;
  }

  const ctx = (panel: HTMLElement, targetSeats: number) => ({
    panel,
    coachSelect: null,
    detailsPanel: null,
    targetSeats,
    policy: 'PREFER_SINGLE_ALLOW_SPLIT' as const,
  });

  it('counts a granted seat when the summary table is unavailable', async () => {
    const outcome = await claimSeats(ctx(grid(3, 1), 2));

    expect(outcome.confirmed).toHaveLength(2);
    expect(outcome.stopReason).toBe('TARGET_REACHED');
  });

  it('never claims more than the requested number of seats', async () => {
    const panel = grid(10, 0);
    const outcome = await claimSeats(ctx(panel, 4));

    expect(outcome.confirmed).toHaveLength(4);
    // The decisive check: exactly four seats are held on the page, not ten.
    expect(panel.querySelectorAll('.seat.selected')).toHaveLength(4);
  });

  it('reports what it secured when fewer seats exist than requested', async () => {
    const outcome = await claimSeats(ctx(grid(2, 5), 4));

    expect(outcome.confirmed).toHaveLength(2);
    expect(outcome.stopReason).toBe('NO_MORE_SEATS');
  });
});

/**
 * A live run produced UMA-53, CHA-66, SCHA-19, UMA-31 — four seats across three coaches, none
 * adjacent, while a coach with 25 free seats went unused. Seat picking was randomised at the
 * time, on the belief that seat clicks raced other users. The network capture disproved that:
 * selecting a seat makes no server call, so the randomisation bought nothing.
 */
describe('seat adjacency', () => {
  const seat = (coach: string, number: number): never =>
    ({ label: `${coach}-${number}`, coach, number, state: 'AVAILABLE', element: null }) as never;

  it('opens at the head of the longest unbroken run', () => {
    // 3 is isolated; 10..13 is the longest run.
    const free = [seat('JA', 3), seat('JA', 10), seat('JA', 11), seat('JA', 12), seat('JA', 13)];
    expect(pickCandidate(free)?.label).toBe('JA-10');
  });

  it('continues the row once a seat is held', () => {
    const free = [seat('JA', 2), seat('JA', 11), seat('JA', 40)];
    expect(pickCandidate(free, ['JA-10'])?.label).toBe('JA-11');
  });

  it('keeps building outward from the seats already held', () => {
    const free = [seat('JA', 13), seat('JA', 30)];
    expect(pickCandidate(free, ['JA-10', 'JA-11', 'JA-12'])?.label).toBe('JA-13');
  });

  it('ignores seats held in a different coach when judging adjacency', () => {
    // UMA-53 must not drag the choice; only this coach's numbering matters.
    const free = [seat('SCHA', 5), seat('SCHA', 6), seat('SCHA', 7)];
    expect(pickCandidate(free, ['UMA-53', 'CHA-66'])?.label).toBe('SCHA-5');
  });

  it('is deterministic — the same grid always yields the same seat', () => {
    const free = [seat('JA', 8), seat('JA', 9), seat('JA', 20)];
    const picks = new Set(Array.from({ length: 10 }, () => pickCandidate(free)?.label));
    expect(picks.size).toBe(1);
  });

  it('returns nothing when no seat is free', () => {
    expect(pickCandidate([])).toBeUndefined();
  });
});

describe('reading the site Seat Details table', () => {
  it('extracts the seats the site says we hold', () => {
    document.body.innerHTML = `
      <div id="details">
        <h3>Seat Details</h3>
        <table>
          <tr><th>Class</th><th>Seats</th><th>Fare</th></tr>
          <tr><td>S_CHAIR</td><td>DA-39</td><td>৳495.00</td></tr>
          <tr><td>S_CHAIR</td><td>DA-44</td><td>৳495.00</td></tr>
        </table>
        <div>Total: ৳ 990</div>
      </div>`;
    const panel = document.getElementById('details') as HTMLElement;

    expect(readClaimedSeats(panel).sort()).toEqual(['DA-39', 'DA-44']);
  });

  it('does not mistake the class name or the fare for a seat', () => {
    document.body.innerHTML = `
      <div id="details"><td>S_CHAIR</td><td>DA-39</td><td>৳495.00</td><div>Total: ৳ 495</div></div>`;
    const panel = document.getElementById('details') as HTMLElement;

    expect(readClaimedSeats(panel)).toEqual(['DA-39']);
  });

  it('returns nothing for an empty table, so a miscount cannot look like a claim', () => {
    document.body.innerHTML = `
      <div id="details"><h3>Seat Details</h3><div>Total: ৳ 0</div></div>`;
    const panel = document.getElementById('details') as HTMLElement;

    expect(readClaimedSeats(panel)).toEqual([]);
  });

  it('returns nothing when there is no panel at all', () => {
    expect(readClaimedSeats(null)).toEqual([]);
  });
});
