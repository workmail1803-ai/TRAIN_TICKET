import { BookingEngine } from '@/automation/booking-engine';
import { Overlay } from './overlay';
import { logger } from '@/utils/logger';
import { sendToPopup, type PopupToContent } from '@/messaging/protocol';

/**
 * Content-script entry point. Runs at document_start, so the engine exists before the page
 * finishes rendering and nothing has to be initialised at 08:00.
 */

const engine = new BookingEngine();

const overlay = new Overlay({
  onStop: () => engine.stop('overlay STOP button'),
  onContinue: () => void engine.continueAfterUser(),
});

engine.onSnapshot((snapshot) => {
  overlay.update(snapshot);
  sendToPopup({ type: 'SNAPSHOT', payload: snapshot });
});

logger.onEntry((entry) => sendToPopup({ type: 'LOG', entry }));

function mountWhenReady(): void {
  if (document.body) {
    overlay.mount();
    overlay.update(engine.snapshot());
    return;
  }
  document.addEventListener('DOMContentLoaded', () => {
    overlay.mount();
    overlay.update(engine.snapshot());
  }, { once: true });
}

mountWhenReady();

/**
 * Emergency stop. Capture phase so the page cannot swallow it first.
 *
 * `isTrusted` is essential, not decoration: the engine itself dispatches synthetic Escape
 * keydowns to dismiss the date picker and other overlays. Without this check those bubble up
 * here and the extension stops itself mid-run - which is exactly what happened on the first
 * live attempt. Only a real key press from a real person counts.
 */
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape' && event.isTrusted) engine.stop('Esc pressed');
  },
  { capture: true }
);

chrome.runtime.onMessage.addListener((message: PopupToContent, _sender, sendResponse) => {
  switch (message.type) {
    case 'ARM':
      void engine.arm();
      sendResponse({ ok: true });
      return false;

    case 'DISARM':
      engine.disarm();
      sendResponse({ ok: true });
      return false;

    case 'STOP':
      engine.stop(message.reason || 'popup STOP');
      sendResponse({ ok: true });
      return false;

    case 'CONTINUE_AFTER_USER':
      void engine.continueAfterUser();
      sendResponse({ ok: true });
      return false;

    case 'RUN_NOW':
      engine.runNow();
      sendResponse({ ok: true });
      return false;

    case 'REQUEST_SNAPSHOT':
      sendResponse({ ok: true, snapshot: engine.snapshot(), log: logger.entries() });
      return false;

    default:
      sendResponse({ ok: false, error: 'unknown message' });
      return false;
  }
});

// Warn once if the tab is backgrounded while a countdown is live - Chrome throttles timers
// there, which would blunt the whole point of the countdown.
document.addEventListener('visibilitychange', () => {
  const snapshot = engine.snapshot();
  if (document.hidden && snapshot.state === 'WAITING_FOR_BOOKING_OPEN') {
    logger.warn('Tab moved to the background while armed - Chrome throttles timers. Bring it back.');
  }
});

logger.info('QuickBook content script ready');
