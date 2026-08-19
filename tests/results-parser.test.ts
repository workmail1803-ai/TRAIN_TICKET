import { describe, expect, it, beforeEach } from 'vitest';
import {
  findNoResultsNotice,
  isBookable,
  mapAvailability,
  matchesTrainPreference,
  parseTrainRows,
} from '@/content/results-parser';
import { classCard, collapsedTrainRow, expandedTrainRow, resultsPage } from './fixtures';

function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('availability mapping', () => {
  it('never guesses when the count is unreadable', () => {
    expect(mapAvailability(null, 4)).toBe('UNKNOWN');
  });

  it('maps counts against the requested seat count', () => {
    expect(mapAvailability(0, 4)).toBe('SOLD_OUT');
    expect(mapAvailability(2, 4)).toBe('LIMITED');
    expect(mapAvailability(4, 4)).toBe('AVAILABLE');
    expect(mapAvailability(9, 4)).toBe('AVAILABLE');
  });
});

describe('train row parsing', () => {
  it('finds every collapsed row and splits name from number', () => {
    mount(
      resultsPage([
        collapsedTrainRow('MADHUMATI EXPRESS', '756'),
        collapsedTrainRow('BANALATA EXPRESS', '792'),
        collapsedTrainRow('PADMA EXPRESS', '760'),
        collapsedTrainRow('DHUMKETU EXPRESS', '770'),
      ])
    );

    const trains = parseTrainRows(4);
    expect(trains).toHaveLength(4);
    expect(trains.map((t) => t.name)).toEqual([
      'MADHUMATI EXPRESS',
      'BANALATA EXPRESS',
      'PADMA EXPRESS',
      'DHUMKETU EXPRESS',
    ]);
    expect(trains[0]!.number).toBe('756');
    expect(trains.every((t) => !t.expanded)).toBe(true);
  });

  it('is not fooled by the live "users are trying to book" counters', () => {
    mount(resultsPage([collapsedTrainRow('PADMA EXPRESS', '760')]));
    const trains = parseTrainRows(4);
    expect(trains).toHaveLength(1);
    expect(trains[0]!.rawLabel).toBe('PADMA EXPRESS (760)');
  });

  it('keeps each row isolated so one row does not swallow another', () => {
    mount(
      resultsPage([
        expandedTrainRow('DHUMKETU EXPRESS', '770', [
          classCard('S_CHAIR', '450', 0),
          classCard('SNIGDHA', '863', 0, true),
        ]),
        collapsedTrainRow('PADMA EXPRESS', '760'),
      ])
    );

    const trains = parseTrainRows(4);
    const dhumketu = trains.find((t) => t.number === '770')!;
    const padma = trains.find((t) => t.number === '760')!;

    expect(dhumketu.classes).toHaveLength(2);
    expect(padma.classes).toHaveLength(0);
  });
});

describe('class card parsing', () => {
  it('reads the class token, fare and ticket count', () => {
    mount(resultsPage([expandedTrainRow('BANALATA EXPRESS', '792', [classCard('S_CHAIR', '585', 2)])]));

    const [offer] = parseTrainRows(4)[0]!.classes;
    expect(offer!.className).toBe('S_CHAIR');
    expect(offer!.fare).toBe(585);
    expect(offer!.seatsLeft).toBe(2);
    expect(offer!.availability).toBe('LIMITED');
  });

  it('treats a card as bookable only when BOOK NOW is rendered', () => {
    mount(
      resultsPage([
        expandedTrainRow('BANALATA EXPRESS', '792', [
          classCard('S_CHAIR', '585', 2), // has BOOK NOW
          classCard('AC_S', '1340', 0, true), // sold out, no button
        ]),
      ])
    );

    const offers = parseTrainRows(4)[0]!.classes;
    const chair = offers.find((o) => o.className === 'S_CHAIR')!;
    const acs = offers.find((o) => o.className === 'AC_S')!;

    expect(chair.hasBookNow).toBe(true);
    expect(isBookable(chair)).toBe(true);

    expect(acs.hasBookNow).toBe(false);
    expect(acs.availability).toBe('SOLD_OUT');
    expect(isBookable(acs)).toBe(false);
  });

  it('does not let AC_CHAIR be shadowed by a shorter token', () => {
    mount(resultsPage([expandedTrainRow('X EXPRESS', '111', [classCard('AC_CHAIR', '900', 5)])]));
    expect(parseTrainRows(4)[0]!.classes[0]!.className).toBe('AC_CHAIR');
  });

  it('marks a sold-out train as entirely unbookable', () => {
    mount(
      resultsPage([
        expandedTrainRow('DHUMKETU EXPRESS', '770', [
          classCard('S_CHAIR', '450', 0),
          classCard('SNIGDHA', '863', 0, true),
          classCard('AC_B', '1597', 0, true),
        ]),
      ])
    );
    const offers = parseTrainRows(4)[0]!.classes;
    expect(offers).toHaveLength(3);
    expect(offers.every((o) => !isBookable(o))).toBe(true);
  });
});

/**
 * Before the date is released the site answers a perfectly valid search with this page rather
 * than an error. At 08:00:00 it means "a moment too early", so the engine must recognise it and
 * re-submit instead of concluding the route has no trains.
 */
describe('empty-results detection', () => {
  it('recognises the live wording', () => {
    mount(`
      <div class="page">
        <div class="journey">Dhaka - Cox's Bazar 27-Aug-2026</div>
        <h3>No train found for selected dates or cities.</h3>
        <p>Please try different dates or cities.</p>
      </div>`);
    expect(findNoResultsNotice()).toContain('no train found');
  });

  it('reports nothing when trains are actually listed', () => {
    mount(
      resultsPage([
        collapsedTrainRow('BANALATA EXPRESS', '792'),
        collapsedTrainRow('PADMA EXPRESS', '760'),
      ])
    );
    expect(findNoResultsNotice()).toBeNull();
  });

  it('is not triggered by the standing "other users may be purchasing" notice', () => {
    mount(resultsPage([collapsedTrainRow('PADMA EXPRESS', '760')]));
    expect(findNoResultsNotice()).toBeNull();
  });

  it('leaves the train list empty in that state, so the engine retries rather than proceeding', () => {
    mount(`<div><h3>No train found for selected dates or cities.</h3></div>`);
    expect(parseTrainRows(4)).toHaveLength(0);
    expect(findNoResultsNotice()).not.toBeNull();
  });
});

describe('train preference matching', () => {
  const train = {
    name: 'DHUMKETU EXPRESS',
    number: '770',
    rawLabel: 'DHUMKETU EXPRESS (770)',
  } as never;

  it('matches full name, partial name and train number', () => {
    expect(matchesTrainPreference(train, 'DHUMKETU EXPRESS')).toBe(true);
    expect(matchesTrainPreference(train, 'dhumketu')).toBe(true);
    expect(matchesTrainPreference(train, '770')).toBe(true);
    expect(matchesTrainPreference(train, 'PADMA')).toBe(false);
  });

  it('never matches on an empty preference', () => {
    expect(matchesTrainPreference(train, '   ')).toBe(false);
  });
});
