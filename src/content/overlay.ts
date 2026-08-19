import type { EngineSnapshot } from '@/messaging/protocol';
import { STATE_LABEL } from '@/automation/booking-states';

/**
 * On-page banner. The popup closes whenever the user clicks the page, so the banner is the
 * only surface that is reliably visible during a run - especially for the STOP button and
 * the "your turn" prompt.
 *
 * Rendered in a closed shadow root so the site's CSS cannot restyle it and our CSS cannot
 * leak into the site.
 */

const HOST_ID = 'rqb-overlay-host';

export interface OverlayCallbacks {
  onStop: () => void;
  onContinue: () => void;
}

export class Overlay {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private statusEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private seatsEl: HTMLElement | null = null;
  private continueBtn: HTMLButtonElement | null = null;

  constructor(private readonly callbacks: OverlayCallbacks) {}

  mount(): void {
    if (this.host || !document.body) return;

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bar {
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        display: flex; align-items: center; gap: 12px;
        padding: 8px 14px;
        font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #fff; background: #14532d;
        box-shadow: 0 1px 6px rgba(0,0,0,.3);
      }
      .bar[data-tone="warn"]   { background: #b45309; }
      .bar[data-tone="danger"] { background: #b91c1c; }
      .bar[data-tone="ok"]     { background: #15803d; }
      .dot { width: 9px; height: 9px; border-radius: 50%; background: #86efac; flex: none; }
      .status { font-weight: 700; letter-spacing: .02em; }
      .detail { opacity: .9; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .seats { font-variant-numeric: tabular-nums; opacity: .95; }
      button {
        font: inherit; font-weight: 700; cursor: pointer;
        border: 0; border-radius: 5px; padding: 5px 12px;
      }
      .stop     { background: #fff; color: #b91c1c; }
      .continue { background: #facc15; color: #422006; }
      .hidden   { display: none; }
    `;

    const bar = document.createElement('div');
    bar.className = 'bar';

    const dot = document.createElement('span');
    dot.className = 'dot';

    this.statusEl = document.createElement('span');
    this.statusEl.className = 'status';
    this.statusEl.textContent = 'QuickBook';

    this.detailEl = document.createElement('span');
    this.detailEl.className = 'detail';

    this.seatsEl = document.createElement('span');
    this.seatsEl.className = 'seats';

    this.continueBtn = document.createElement('button');
    this.continueBtn.className = 'continue hidden';
    this.continueBtn.textContent = 'CONTINUE';
    this.continueBtn.addEventListener('click', () => this.callbacks.onContinue());

    const stopBtn = document.createElement('button');
    stopBtn.className = 'stop';
    stopBtn.textContent = 'STOP (Esc)';
    stopBtn.addEventListener('click', () => this.callbacks.onStop());

    bar.append(dot, this.statusEl, this.detailEl, this.seatsEl, this.continueBtn, stopBtn);
    this.root.append(style, bar);
    document.body.appendChild(this.host);
  }

  update(snapshot: EngineSnapshot): void {
    if (!this.root) return;
    const bar = this.root.querySelector('.bar') as HTMLElement | null;
    if (!bar) return;

    const tone =
      snapshot.state === 'SUCCESS' ? 'ok'
      : snapshot.state === 'FAILED' ? 'danger'
      : snapshot.awaitingUserReason ? 'warn'
      : 'default';
    bar.dataset.tone = tone;

    if (this.statusEl) this.statusEl.textContent = STATE_LABEL[snapshot.state] ?? snapshot.state;

    if (this.detailEl) {
      const countdown =
        snapshot.targetEpochMs && snapshot.state === 'WAITING_FOR_BOOKING_OPEN'
          ? `T-${Math.max(0, (snapshot.targetEpochMs - Date.now() - snapshot.serverOffsetMs) / 1000).toFixed(1)}s`
          : '';
      const hidden = snapshot.tabHidden ? ' — tab is in the background, keep it focused' : '';
      this.detailEl.textContent = snapshot.awaitingUserReason ?? `${countdown} ${snapshot.detail}${hidden}`.trim();
    }

    if (this.seatsEl) {
      this.seatsEl.textContent = snapshot.confirmedSeats.length
        ? `seats ${snapshot.confirmedSeats.length}/${snapshot.targetSeats}: ${snapshot.confirmedSeats.join(' ')}`
        : '';
    }

    this.continueBtn?.classList.toggle('hidden', !snapshot.awaitingUserReason);
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}
