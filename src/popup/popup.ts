import type { LogEntry } from '@/types';
import type { ContentToPopup, EngineSnapshot } from '@/messaging/protocol';
import { STATE_LABEL } from '@/automation/booking-states';
import { loadConfig } from '@/storage/storage-manager';

/**
 * The popup is a pure view. It holds no state, and closing it never affects a run - the
 * engine lives in the content script.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  route: $('route'),
  date: $('date'),
  train: $('train'),
  class: $('class'),
  seats: $('seats'),
  state: $('state'),
  dot: $('dot'),
  elapsed: $('elapsed'),
  detail: $('detail'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  issues: $('issues'),
  arm: $<HTMLButtonElement>('arm'),
  stop: $<HTMLButtonElement>('stop'),
  runNow: $<HTMLButtonElement>('run-now'),
  continue: $<HTMLButtonElement>('continue'),
  clock: $('clock'),
  warnHidden: $('warn-hidden'),
  log: $<HTMLUListElement>('log'),
  openOptions: $('open-options'),
};

let countdownTimer: number | null = null;
let latest: EngineSnapshot | null = null;

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function send<T>(message: unknown): Promise<T | null> {
  const tabId = await activeTabId();
  if (tabId === null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch {
    return null;
  }
}

function renderConfig(): void {
  void loadConfig().then((config) => {
    const { journey, preferences, seatPolicy } = config;
    els.route.textContent =
      journey.fromStation && journey.toStation
        ? `${journey.fromStation} → ${journey.toStation}`
        : 'Route not set';
    els.date.textContent = journey.dateISO || 'Date not set';
    els.train.textContent = preferences.trainPriority.filter(Boolean).join(' › ') || '—';
    els.class.textContent = preferences.classPriority.join(' › ') || '—';
    els.seats.textContent = String(seatPolicy.targetSeats);
  });
}

function toneFor(snapshot: EngineSnapshot): string {
  if (snapshot.state === 'FAILED') return 'danger';
  if (snapshot.state === 'SUCCESS') return 'live';
  if (snapshot.awaitingUserReason) return 'warn';
  if (snapshot.armed) return 'live';
  return 'idle';
}

function render(snapshot: EngineSnapshot): void {
  latest = snapshot;

  els.state.textContent = STATE_LABEL[snapshot.state] ?? snapshot.state;
  els.dot.dataset.tone = toneFor(snapshot);
  els.elapsed.textContent = snapshot.armed ? `${(snapshot.elapsedMs / 1000).toFixed(3)} s` : '';
  els.detail.textContent = snapshot.detail || '';

  const waiting = !!snapshot.awaitingUserReason;
  els.banner.classList.toggle('hidden', !waiting);
  els.bannerText.textContent = snapshot.awaitingUserReason ?? '';

  els.warnHidden.classList.toggle('hidden', !(snapshot.tabHidden && snapshot.armed));

  if (snapshot.issues.length > 0) {
    els.issues.classList.remove('hidden');
    els.issues.innerHTML =
      '<strong>Cannot arm yet</strong><ul>' +
      snapshot.issues.map((i) => `<li>${escapeHtml(i.message)}</li>`).join('') +
      '</ul>';
  } else {
    els.issues.classList.add('hidden');
  }

  if (snapshot.confirmedSeats.length > 0) {
    els.seats.textContent = `${snapshot.confirmedSeats.length}/${snapshot.targetSeats} — ${snapshot.confirmedSeats.join(' ')}`;
  }

  els.arm.disabled = snapshot.armed;
  // Only meaningful while the countdown is actually running.
  els.runNow.disabled = snapshot.state !== 'WAITING_FOR_BOOKING_OPEN';

  const confidence = Number.isFinite(snapshot.serverOffsetConfidenceMs)
    ? `±${snapshot.serverOffsetConfidenceMs} ms`
    : 'not synced';
  els.clock.textContent = `Clock offset ${snapshot.serverOffsetMs} ms (${confidence}) · page: ${snapshot.page}${snapshot.loggedIn ? '' : ' · NOT LOGGED IN'}`;

  startCountdown();
}

function startCountdown(): void {
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    if (!latest?.targetEpochMs || latest.state !== 'WAITING_FOR_BOOKING_OPEN') return;
    const remaining = (latest.targetEpochMs - Date.now() - latest.serverOffsetMs) / 1000;
    els.detail.textContent = `Opens in ${Math.max(0, remaining).toFixed(1)} s (Asia/Dhaka)`;
  }, 100);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );
}

function appendLog(entry: LogEntry): void {
  const li = document.createElement('li');
  li.dataset.level = entry.level;
  li.textContent = `${entry.wall.slice(11)} ${entry.message}`;
  els.log.appendChild(li);
  while (els.log.children.length > 300) els.log.removeChild(els.log.firstChild!);
  els.log.scrollTop = els.log.scrollHeight;
}

// --- wiring -----------------------------------------------------------------

els.arm.addEventListener('click', () => void send({ type: 'ARM' }));
els.stop.addEventListener('click', () => void send({ type: 'STOP', reason: 'popup STOP button' }));
els.runNow.addEventListener('click', () => void send({ type: 'RUN_NOW' }));
els.continue.addEventListener('click', () => void send({ type: 'CONTINUE_AFTER_USER' }));
els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message: ContentToPopup) => {
  if (message.type === 'SNAPSHOT') render(message.payload);
  if (message.type === 'LOG') appendLog(message.entry);
});

void (async () => {
  renderConfig();
  const response = await send<{ ok: boolean; snapshot: EngineSnapshot; log: LogEntry[] }>({
    type: 'REQUEST_SNAPSHOT',
  });
  if (!response?.ok) {
    els.state.textContent = 'Not on the Railway site';
    els.detail.textContent = 'Open the Railway booking page in this tab, then reopen this popup.';
    els.arm.disabled = true;
    return;
  }
  response.log.forEach(appendLog);
  render(response.snapshot);
})();
