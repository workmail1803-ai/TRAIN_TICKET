import type { AppConfig, BookingResult, PassengerProfile, RunState, ValidationIssue } from '@/types';

/**
 * chrome.storage.local access with one versioned root and a migration hook.
 *
 * NEVER stored, in any form: passwords, card numbers, CVV, OTP codes, CAPTCHA tokens,
 * session cookies. There is no field for them and none may be added.
 */

const CONFIG_KEY = 'rqb.config';
const RUN_STATE_KEY = 'rqb.runState';
const RESULT_KEY = 'rqb.lastResult';

export const SCHEMA_VERSION = 1;

function emptyPassenger(index: number): PassengerProfile {
  return {
    id: `p${index + 1}`,
    name: '',
    age: '',
    gender: '',
    passengerType: 'Adult',
    extra: {},
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: SCHEMA_VERSION,
  journey: { fromStation: '', toStation: '', dateISO: '', searchClass: '' },
  preferences: { trainPriority: ['', '', ''], classPriority: [] },
  seatPolicy: {
    targetSeats: 4,
    // Chosen by the user: secure whatever exists, then hand over.
    partial: 'TAKE_AVAILABLE_THEN_STOP',
    // Chosen by the user: any 4 beats 4 together, but prefer one coach when possible.
    coachSpread: 'PREFER_SINGLE_ALLOW_SPLIT',
  },
  schedule: {
    openTimeBST: '08:00:00',
    offsetMs: 0,
    allowClockFallback: true,
    maxWaitAfterT0Ms: 120_000,
    // ~10 searches over ~4s. Covers the clock's own margin plus a little server-side lag in
    // releasing the date, without turning into a refresh loop.
    maxEmptyRetries: 10,
    emptyRetryGapMs: 400,
  },
  passengers: [0, 1, 2, 3].map(emptyPassenger),
  selectorOverrides: {},
  // Stays off until the passenger page DOM has actually been supplied and verified.
  enablePassengerAutofill: false,
};

function mergeConfig(stored: Partial<AppConfig> | undefined): AppConfig {
  if (!stored) return structuredClone(DEFAULT_CONFIG);

  const merged: AppConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ...stored,
    journey: { ...DEFAULT_CONFIG.journey, ...(stored.journey ?? {}) },
    preferences: { ...DEFAULT_CONFIG.preferences, ...(stored.preferences ?? {}) },
    seatPolicy: { ...DEFAULT_CONFIG.seatPolicy, ...(stored.seatPolicy ?? {}) },
    schedule: { ...DEFAULT_CONFIG.schedule, ...(stored.schedule ?? {}) },
    passengers: (stored.passengers ?? DEFAULT_CONFIG.passengers).map((p, i) => ({
      ...emptyPassenger(i),
      ...p,
    })),
    selectorOverrides: stored.selectorOverrides ?? {},
  };

  // Always exactly four slots, so the UI and the validator agree.
  while (merged.passengers.length < 4) merged.passengers.push(emptyPassenger(merged.passengers.length));
  merged.passengers = merged.passengers.slice(0, 4);
  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

export async function loadConfig(): Promise<AppConfig> {
  const raw = await chrome.storage.local.get(CONFIG_KEY);
  return mergeConfig(raw[CONFIG_KEY] as Partial<AppConfig> | undefined);
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...config, schemaVersion: SCHEMA_VERSION } });
}

export async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const next = mergeConfig({ ...(await loadConfig()), ...patch });
  await saveConfig(next);
  return next;
}

// ---------------------------------------------------------------------------
// Validation - runs at ARM, long before the booking window
// ---------------------------------------------------------------------------

/**
 * Everything that could stop a booking is checked here, at 07:50, where a failure costs
 * nothing. Discovering a blank field at 08:00:00.4 costs the booking.
 */
export function validateConfig(config: AppConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { journey, preferences, seatPolicy, passengers, schedule } = config;

  if (!journey.fromStation.trim()) issues.push({ field: 'journey.fromStation', message: 'Origin station is empty' });
  if (!journey.toStation.trim()) issues.push({ field: 'journey.toStation', message: 'Destination station is empty' });
  if (journey.fromStation.trim() && journey.fromStation.trim() === journey.toStation.trim()) {
    issues.push({ field: 'journey.toStation', message: 'Origin and destination are the same' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(journey.dateISO)) {
    issues.push({ field: 'journey.dateISO', message: 'Journey date is not set (expected yyyy-mm-dd)' });
  } else if (Number.isNaN(Date.parse(journey.dateISO))) {
    issues.push({ field: 'journey.dateISO', message: `"${journey.dateISO}" is not a real date` });
  }

  const trains = preferences.trainPriority.map((t) => t.trim()).filter(Boolean);
  if (trains.length === 0) {
    issues.push({ field: 'preferences.trainPriority', message: 'Set at least one preferred train' });
  }

  if (preferences.classPriority.length === 0) {
    issues.push({ field: 'preferences.classPriority', message: 'Set at least one preferred class' });
  }

  if (seatPolicy.targetSeats < 1 || seatPolicy.targetSeats > 4) {
    issues.push({
      field: 'seatPolicy.targetSeats',
      message: 'Seat count must be between 1 and 4. The extension never attempts more than the account allows.',
    });
  }

  try {
    const [h, m] = schedule.openTimeBST.split(':');
    if (Number.isNaN(Number(h)) || Number.isNaN(Number(m))) throw new Error('bad');
  } catch {
    issues.push({ field: 'schedule.openTimeBST', message: 'Opening time must be HH:mm or HH:mm:ss' });
  }

  // Only the profiles we will actually use must be complete.
  passengers.slice(0, seatPolicy.targetSeats).forEach((p, i) => {
    const label = `Passenger ${i + 1}`;
    if (!p.name.trim()) issues.push({ field: `passengers.${i}.name`, message: `${label}: name is empty` });
    if (!p.age.trim()) issues.push({ field: `passengers.${i}.age`, message: `${label}: age is empty` });
    if (!p.gender.trim()) issues.push({ field: `passengers.${i}.gender`, message: `${label}: gender is empty` });
  });

  return issues;
}

// ---------------------------------------------------------------------------
// Run state - refresh recovery
// ---------------------------------------------------------------------------

export async function saveRunState(state: RunState): Promise<void> {
  await chrome.storage.local.set({ [RUN_STATE_KEY]: state });
}

export async function loadRunState(): Promise<RunState | null> {
  const raw = await chrome.storage.local.get(RUN_STATE_KEY);
  return (raw[RUN_STATE_KEY] as RunState | undefined) ?? null;
}

export async function clearRunState(): Promise<void> {
  await chrome.storage.local.remove(RUN_STATE_KEY);
}

export async function saveResult(result: BookingResult): Promise<void> {
  await chrome.storage.local.set({ [RESULT_KEY]: result });
}

export async function loadResult(): Promise<BookingResult | null> {
  const raw = await chrome.storage.local.get(RESULT_KEY);
  return (raw[RESULT_KEY] as BookingResult | undefined) ?? null;
}
