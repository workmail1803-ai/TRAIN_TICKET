/**
 * Service worker - deliberately minimal.
 *
 * MV3 workers are evicted after roughly 30 seconds idle, and chrome.alarms granularity is
 * far too coarse for a sub-second trigger. So the worker does NOT own the countdown; the
 * content script does. This is only a coarse backstop that reminds the user to have the tab
 * open and armed, plus a place to hang lifecycle events.
 */

const PREP_ALARM = 'rqb.prepReminder';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('rqb.config').then((raw) => {
    if (!raw['rqb.config']) {
      // First run: open options so the user configures before they ever need to hurry.
      void chrome.runtime.openOptionsPage();
    }
  });
});

/**
 * Fires ~10 minutes before the configured opening time as a nudge. It is a reminder only -
 * nothing time-critical depends on it.
 */
async function scheduleReminder(): Promise<void> {
  const raw = await chrome.storage.local.get('rqb.config');
  const config = raw['rqb.config'] as { schedule?: { openTimeBST?: string } } | undefined;
  const openTime = config?.schedule?.openTimeBST ?? '08:00:00';

  const [hourStr, minuteStr] = openTime.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr ?? '0');
  if (Number.isNaN(hour) || Number.isNaN(minute)) return;

  // Asia/Dhaka wall time -> epoch, without trusting the machine's timezone.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date())) if (p.type !== 'literal') parts[p.type] = p.value;

  const asIfUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  const offset = asIfUTC - Math.floor(Date.now() / 1000) * 1000;

  let target = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute, 0) - offset;
  if (target <= Date.now()) target += 24 * 60 * 60 * 1000;

  const when = target - 10 * 60 * 1000;
  await chrome.alarms.create(PREP_ALARM, { when: when > Date.now() ? when : Date.now() + 60_000 });
}

void scheduleReminder();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['rqb.config']) void scheduleReminder();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PREP_ALARM) return;

  const granted = await chrome.permissions.contains({ permissions: ['notifications'] });
  if (!granted) return;

  chrome.notifications?.create({
    type: 'basic',
    iconUrl: 'icon-128.png',
    title: 'Railway QuickBook',
    message: 'Booking opens in ~10 minutes. Log in, open the search page, and press ARM.',
    priority: 2,
  });
});
