import { CONFIRMATION } from '@/selectors/railway-selectors';
import type { BookingResult } from '@/types';
import { isVisible, normText } from './element-finder';

/**
 * Confirmation parser.
 *
 * UNVERIFIED: no confirmation page has been supplied. This reads the reference by locating
 * a label ("PNR", "Booking Reference", ...) and taking the value beside or beneath it,
 * which is the arrangement every variant of this page uses. If nothing is found the caller
 * reports "booked but reference not parsed" rather than inventing a value - a wrong
 * reference on a real, paid booking is worse than no reference.
 */

const REFERENCE_VALUE = /\b([A-Z0-9]{6,20})\b/;

function nearbyValue(labelEl: HTMLElement): string | null {
  const probes: Array<Element | null | undefined> = [
    labelEl.nextElementSibling,
    labelEl.parentElement?.nextElementSibling,
    labelEl.parentElement,
  ];

  for (const probe of probes) {
    if (!probe) continue;
    const text = (probe.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    // Strip the label itself if the value shares its container.
    const withoutLabel = text.replace(new RegExp(labelEl.textContent?.trim() ?? '', 'i'), '').trim();
    const match = REFERENCE_VALUE.exec(withoutLabel.toUpperCase());
    if (match?.[1]) return match[1];
  }
  return null;
}

export function parseConfirmation(passengerCount: number, seats: string[]): BookingResult {
  const result: BookingResult = {
    reference: null,
    train: null,
    date: null,
    route: null,
    travelClass: null,
    passengerCount,
    seats,
    capturedAtWall: Date.now(),
  };

  const candidates = document.querySelectorAll<HTMLElement>('span, div, td, th, p, strong, label, h1, h2, h3');

  for (const el of Array.from(candidates)) {
    if (!isVisible(el)) continue;
    if (el.children.length > 1) continue;
    const text = normText(el.textContent);
    if (!text || text.length > 60) continue;

    if (CONFIRMATION.referenceLabels.some((label) => text.includes(label))) {
      const value = nearbyValue(el);
      if (value) {
        result.reference = value;
        break;
      }
    }
  }

  return result;
}

export function hasConfirmationMarker(): string | null {
  const body = normText(document.body?.innerText ?? '');
  return CONFIRMATION.textHints.find((hint) => body.includes(hint)) ?? null;
}
