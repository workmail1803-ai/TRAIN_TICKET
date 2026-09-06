import type { AppConfig, ValidationIssue } from '@/types';
import { serverNow, zonedParts } from '@/utils/timing';

/**
 * Pre-flight checks that run at ARM, against the live site.
 *
 * validateConfig() only checks that fields are non-empty. It cannot catch the failure that has
 * actually cost bookings: a preference that is well-formed but does not match anything the site
 * serves. A run was lost to `BANALATA EXPRESS (792)` when the route lists
 * `BANALATA EXPRESS (791)` - train numbers are direction-specific - and the mistake was only
 * discovered at 08:00, with nothing left to do about it.
 *
 * These checks cost one or two GETs, minutes before the window, and turn that class of mistake
 * into a message you can act on.
 *
 * Deliberately string-based: the search page is fetched as text and matched with regexes rather
 * than parsed into a document. A detached document has no layout, so getBoundingClientRect
 * returns zeroes and every visibility check in the normal parsers would fail.
 */

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** ISO `2026-09-09` -> `09-Sep-2026`, the format the site's own URL uses. */
export function formatDojForUrl(isoDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const monthName = MONTHS_SHORT[Number(month) - 1];
  if (!monthName) return null;
  return `${day}-${monthName}-${year}`;
}

/**
 * The site's search URL. Verified from the live site: submitting the form routes here, and the
 * URL is directly loadable.
 */
export function buildSearchUrl(
  origin: string,
  journey: { fromStation: string; toStation: string; searchClass: string },
  dojIso: string
): string | null {
  const doj = formatDojForUrl(dojIso);
  if (!doj) return null;

  const params = new URLSearchParams({
    fromcity: journey.fromStation.trim(),
    tocity: journey.toStation.trim(),
    doj,
    class: journey.searchClass,
  });
  return `${origin}/booking/train/search?${params.toString()}`;
}

/** Train labels present in a search-results page, e.g. `BANALATA EXPRESS (791)`. */
export function extractTrainLabels(html: string): string[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const found = new Set<string>();
  for (const match of text.matchAll(/([A-Z][A-Z0-9'.&\-\s]{3,40}?)\s*\((\d{2,5})\)/g)) {
    const name = (match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (name.length >= 4) found.add(`${name} (${match[2]})`);
  }
  return [...found];
}

export function hasNoTrainsNotice(html: string): boolean {
  return /no\s+train\s+found/i.test(html);
}

export interface ProbeResult {
  reachable: boolean;
  noTrains: boolean;
  labels: string[];
  note?: string;
}

async function probe(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const response = await fetch(url, { credentials: 'include', ...(signal ? { signal } : {}) });
    if (!response.ok) {
      return { reachable: false, noTrains: false, labels: [], note: `HTTP ${response.status}` };
    }
    const html = await response.text();
    return {
      reachable: true,
      noTrains: hasNoTrainsNotice(html),
      labels: extractTrainLabels(html),
    };
  } catch (error) {
    return {
      reachable: false,
      noTrains: false,
      labels: [],
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A date a few days out, used to validate stations and train names when the target is unreleased. */
function fallbackProbeDateIso(): string {
  const parts = zonedParts(serverNow() + 2 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Loose match, mirroring matchesTrainPreference so ARM and 08:00 agree. */
function labelMatchesPreference(label: string, preference: string): boolean {
  const wanted = preference.trim().toLowerCase();
  if (!wanted) return false;
  const lower = label.toLowerCase();
  if (lower.includes(wanted)) return true;
  const number = /\((\d{2,5})\)/.exec(label)?.[1];
  return number === wanted;
}

export interface PreflightOutcome {
  issues: ValidationIssue[];
  labelsSeen: string[];
  probedDateIso: string | null;
  /** Preferences that matched a train the site actually lists. */
  matched: string[];
  /** Preferences that matched nothing. */
  unmatched: string[];
  /** True when the route itself could not be verified at all. */
  routeBroken: boolean;
}

/**
 * Check the journey against the live site before arming.
 *
 * Returns issues, not exceptions - the caller decides whether any are fatal. A train that simply
 * does not run on the probe date would otherwise produce a false alarm, so a missing train is
 * reported as something to check rather than a hard failure.
 */
export async function runPreflight(
  config: AppConfig,
  origin: string,
  signal?: AbortSignal
): Promise<PreflightOutcome> {
  const issues: ValidationIssue[] = [];

  const searchClass = config.journey.searchClass || config.preferences.classPriority[0] || '';
  const journey = { ...config.journey, searchClass };

  const targetUrl = buildSearchUrl(origin, journey, config.journey.dateISO);
  if (!targetUrl) {
    issues.push({
      field: 'journey.dateISO',
      message: `Cannot build a search URL from date "${config.journey.dateISO}".`,
    });
    return {
      issues,
      labelsSeen: [],
      probedDateIso: null,
      matched: [],
      unmatched: [],
      routeBroken: true,
    };
  }

  // Try the real journey first. If the date is already released this validates everything at once.
  let result = await probe(targetUrl, signal);
  let probedDateIso = config.journey.dateISO;

  if (result.reachable && result.noTrains) {
    // Expected before the window opens. Fall back to a near date purely to validate the route,
    // the class and the train names.
    probedDateIso = fallbackProbeDateIso();
    const fallbackUrl = buildSearchUrl(origin, journey, probedDateIso);
    if (fallbackUrl) result = await probe(fallbackUrl, signal);
  }

  if (!result.reachable) {
    issues.push({
      field: 'preflight',
      message: `Could not check the journey against the site (${result.note ?? 'request failed'}). Arming anyway, but nothing has been verified.`,
    });
    return { issues, labelsSeen: [], probedDateIso, matched: [], unmatched: [], routeBroken: false };
  }

  if (result.noTrains) {
    issues.push({
      field: 'journey',
      message:
        `The site returns no trains for ${journey.fromStation} → ${journey.toStation} ` +
        `even on ${probedDateIso}. Check the station spellings and the class - they must match ` +
        'the site exactly.',
    });
    return { issues, labelsSeen: [], probedDateIso, matched: [], unmatched: [], routeBroken: true };
  }

  // The route works. Now the check that would have saved the lost run.
  const preferences = config.preferences.trainPriority.map((t) => t.trim()).filter(Boolean);
  const matched = preferences.filter((preference) =>
    result.labels.some((label) => labelMatchesPreference(label, preference))
  );
  const unmatched = preferences.filter((preference) => !matched.includes(preference));

  if (unmatched.length > 0 && result.labels.length > 0) {
    issues.push({
      field: 'preferences.trainPriority',
      message:
        `Not on this route: ${unmatched.join(', ')}. The site lists: ${result.labels.join(', ')}. ` +
        'Train numbers are direction-specific, so prefer the name alone (e.g. "BANALATA").',
    });
  }

  return {
    issues,
    labelsSeen: result.labels,
    probedDateIso,
    matched,
    unmatched,
    routeBroken: false,
  };
}
