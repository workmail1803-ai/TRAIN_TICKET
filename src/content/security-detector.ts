import { PAYMENT, SECURITY } from '@/selectors/railway-selectors';
import { isVisible, normText } from './element-finder';

/**
 * DETECTION ONLY.
 *
 * This module answers exactly one question: "is a human verification step on screen right
 * now?" It never reads challenge content, never extracts a token, never submits anything,
 * and never touches the widget. When it returns a finding the engine halts and hands the
 * page to the user.
 *
 * Nothing here may ever be extended into solving, forwarding, or bypassing a challenge.
 */

export interface SecurityFinding {
  kind: 'CAPTCHA' | 'OTP' | 'VERIFICATION';
  /** Where it was spotted. Deliberately coarse - never challenge content. */
  evidence: string;
}

function scanIframes(): SecurityFinding | null {
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    const src = (frame.getAttribute('src') ?? '').toLowerCase();
    if (!src) continue;
    const hit = SECURITY.iframeSrcHints.find((hint) => src.includes(hint));
    if (hit && isVisible(frame)) return { kind: 'CAPTCHA', evidence: `iframe:${hit}` };
  }
  return null;
}

function scanDom(): SecurityFinding | null {
  for (const selector of SECURITY.domHints) {
    let nodes: Element[];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (nodes.some((node) => isVisible(node))) {
      return { kind: 'CAPTCHA', evidence: `dom:${selector}` };
    }
  }
  return null;
}

function scanText(): SecurityFinding | null {
  // Only look at leaf-ish visible elements, so one hit does not match the whole page.
  const candidates = document.querySelectorAll<HTMLElement>('label, p, span, div, h1, h2, h3, h4, legend');

  for (const el of Array.from(candidates)) {
    if (el.children.length > 2) continue;
    if (!isVisible(el)) continue;
    const text = normText(el.textContent);
    if (!text || text.length > 160) continue;

    const hit = SECURITY.textHints.find((hint) => text.includes(hint));
    if (!hit) continue;

    const kind: SecurityFinding['kind'] = hit.includes('otp') || hit.includes('one time') || hit.includes('one-time') || hit.includes('verification code')
      ? 'OTP'
      : hit.includes('captcha') || hit.includes('robot')
        ? 'CAPTCHA'
        : 'VERIFICATION';

    return { kind, evidence: `text:${hit}` };
  }
  return null;
}

/** Cheap enough to call between stages. Returns null when the page is clear. */
export function detectSecurity(): SecurityFinding | null {
  return scanIframes() ?? scanDom() ?? scanText();
}

export interface PaymentFinding {
  evidence: string;
}

/**
 * Payment is a hand-over point, never automated. Detection only.
 *
 * Restricted to actionable controls and headings carrying an action phrase. Scanning general
 * body text produced a false positive on the home page, whose hero copy mentions "online
 * payment method" next to a wallet-logo strip.
 */
export function detectPayment(siteOrigin: string): PaymentFinding | null {
  if (PAYMENT.offSiteMeansGateway && location.origin !== siteOrigin) {
    return { evidence: `off-site:${location.origin}` };
  }

  const candidates = document.querySelectorAll<HTMLElement>(PAYMENT.actionTags.join(', '));
  for (const el of Array.from(candidates)) {
    if (el.children.length > 2) continue;
    if (!isVisible(el)) continue;
    const text = normText(el.textContent);
    if (!text || text.length > 80) continue;
    const hit = PAYMENT.actionHints.find((hint) => text.includes(hint));
    if (hit) return { evidence: `text:${hit}` };
  }
  return null;
}
