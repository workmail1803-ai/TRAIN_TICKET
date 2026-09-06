import { describe, expect, it } from 'vitest';
import { buildSearchUrl, extractTrainLabels, formatDojForUrl, hasNoTrainsNotice } from '@/content/preflight';

/**
 * The pre-flight exists because of a real lost booking: the config said
 * `BANALATA EXPRESS (792)` while the route lists `BANALATA EXPRESS (791)` — train numbers are
 * direction-specific — and it was only discovered at 08:00.
 */

describe('journey date formatting', () => {
  it('produces the format the site URL uses', () => {
    expect(formatDojForUrl('2026-09-09')).toBe('09-Sep-2026');
    expect(formatDojForUrl('2026-01-01')).toBe('01-Jan-2026');
    expect(formatDojForUrl('2026-12-31')).toBe('31-Dec-2026');
  });

  it('refuses anything that is not yyyy-mm-dd rather than guessing', () => {
    expect(formatDojForUrl('09-09-2026')).toBeNull();
    expect(formatDojForUrl('2026-9-9')).toBeNull();
    expect(formatDojForUrl('')).toBeNull();
    expect(formatDojForUrl('2026-13-01')).toBeNull();
  });
});

describe('search URL construction', () => {
  const journey = { fromStation: 'Dhaka', toStation: 'Rajshahi', searchClass: 'SNIGDHA' };

  it('matches the URL observed on the live site', () => {
    const url = buildSearchUrl('https://eticket.railway.gov.bd', journey, '2026-09-09');
    expect(url).toBe(
      'https://eticket.railway.gov.bd/booking/train/search' +
        '?fromcity=Dhaka&tocity=Rajshahi&doj=09-Sep-2026&class=SNIGDHA'
    );
  });

  it('encodes station names containing spaces', () => {
    const url = buildSearchUrl(
      'https://eticket.railway.gov.bd',
      { ...journey, fromStation: 'Dhaka Cantonment' },
      '2026-09-09'
    );
    expect(url).toContain('fromcity=Dhaka+Cantonment');
  });

  it('returns null on a bad date instead of building a broken URL', () => {
    expect(buildSearchUrl('https://x', journey, 'not-a-date')).toBeNull();
  });
});

describe('reading a results page as text', () => {
  // Shaped like the real page: headings, a live counter, and markup around them.
  const page = `
    <html><head><style>.a{color:red}</style></head><body>
      <div class="notice">Please Note: Other users may be purchasing tickets.</div>
      <h3 class="trip">DHUMKETU EXPRESS (769)</h3>
      <span>0+ users are trying to book ticket(s)</span>
      <h3 class="trip">BANALATA EXPRESS (791)</h3>
      <h3 class="trip">SILKCITY EXPRESS (753)</h3>
      <script>var x = "MADHUMATI EXPRESS (999)";</script>
    </body></html>`;

  it('extracts the train labels the site is actually serving', () => {
    const labels = extractTrainLabels(page);
    expect(labels).toContain('DHUMKETU EXPRESS (769)');
    expect(labels).toContain('BANALATA EXPRESS (791)');
    expect(labels).toContain('SILKCITY EXPRESS (753)');
  });

  it('ignores script contents, so page code cannot invent a train', () => {
    expect(extractTrainLabels(page)).not.toContain('MADHUMATI EXPRESS (999)');
  });

  it('is not fooled into reporting the wrong direction number', () => {
    // The exact mistake that cost a booking: 792 is the return working.
    const labels = extractTrainLabels(page);
    expect(labels).toContain('BANALATA EXPRESS (791)');
    expect(labels).not.toContain('BANALATA EXPRESS (792)');
  });

  it('detects the empty-results page', () => {
    expect(hasNoTrainsNotice('<h3>No train found for selected dates or cities.</h3>')).toBe(true);
    expect(hasNoTrainsNotice(page)).toBe(false);
  });
});
