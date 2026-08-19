import type { ElementDescriptor } from '@/selectors/railway-selectors';
import { findAll, findOne, isEnabled, isVisible, normText } from './element-finder';
import { waitFor, type WaitOptions } from '@/utils/wait';

/**
 * DOM-specific waits built on the generic engine. Every one is event-driven; none sleeps.
 *
 * Scoping note: callers should pass the narrowest possible `scope`. This site runs live
 * "N users are trying to book" and "Total Active Users" counters that mutate constantly,
 * so a document-wide observer would fire nonstop at exactly the wrong moment.
 */

type WaitArgs = Omit<WaitOptions, 'what'> & { what?: string };

function opts(fallbackWhat: string, args: WaitArgs): WaitOptions {
  return { ...args, what: args.what ?? fallbackWhat };
}

export function waitForElement(
  descriptor: ElementDescriptor,
  args: WaitArgs & { enabled?: boolean }
): Promise<HTMLElement> {
  return waitFor(
    () => findOne(descriptor, { root: (args.scope as ParentNode) ?? document, enabled: args.enabled }),
    opts(descriptor.key, args)
  );
}

export function waitForAll(
  descriptor: ElementDescriptor,
  minimum: number,
  args: WaitArgs
): Promise<HTMLElement[]> {
  return waitFor(() => {
    const found = findAll(descriptor, { root: (args.scope as ParentNode) ?? document });
    return found.length >= minimum ? found : null;
  }, opts(`${descriptor.key} x${minimum}`, args));
}

export function waitForVisible(element: HTMLElement, args: WaitArgs): Promise<HTMLElement> {
  return waitFor(() => (isVisible(element) ? element : null), opts('element visible', args));
}

export function waitForEnabled(element: HTMLElement, args: WaitArgs): Promise<HTMLElement> {
  return waitFor(
    () => (isEnabled(element) && isVisible(element) ? element : null),
    // Some sites enable a control purely via CSS or a framework property that produces no
    // mutation record. A slow poll is the safety net; the observer still does the work.
    { ...opts('element enabled', args), pollMs: args.pollMs ?? 60 }
  );
}

export function waitForText(
  container: HTMLElement,
  needles: string[],
  args: WaitArgs
): Promise<string> {
  const wanted = needles.map(normText);
  return waitFor(() => {
    const text = normText(container.innerText ?? container.textContent ?? '');
    const hit = wanted.find((w) => text.includes(w));
    return hit ?? null;
  }, opts(`text ${needles.join(' | ')}`, args));
}

export function waitForRemoved(element: HTMLElement, args: WaitArgs): Promise<true> {
  return waitFor(
    () => (!element.isConnected || !isVisible(element) ? (true as const) : null),
    opts('element removed', args)
  );
}

export function waitForURLChange(from: string, args: WaitArgs): Promise<string> {
  return waitFor(() => (location.href !== from ? location.href : null), {
    // History API navigation emits no mutation on its own, so this one genuinely needs a poll.
    ...opts('url change', args),
    pollMs: args.pollMs ?? 50,
    scope: args.scope ?? document.documentElement,
  });
}

/** Wait for either of two outcomes, telling the caller which one happened. */
export async function waitForEither<A, B>(
  a: { label: string; run: () => Promise<A> },
  b: { label: string; run: () => Promise<B> }
): Promise<{ label: string; a?: A; b?: B }> {
  return Promise.race([
    a.run().then((value) => ({ label: a.label, a: value })),
    b.run().then((value) => ({ label: b.label, b: value })),
  ]);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export function scrollIntoViewIfNeeded(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const withinViewport =
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth);
  if (!withinViewport) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  }
}

/**
 * Dispatch a full pointer + mouse sequence rather than calling .click().
 *
 * Many widgets bind to mousedown/pointerdown rather than click, and a bare .click() misses
 * them. The default action still fires from the synthetic click event, so anchors navigate
 * normally. We do NOT also call .click(), which would double-fire the handler.
 */
export function realClick(element: HTMLElement): void {
  scrollIntoViewIfNeeded(element);

  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY };

  element.dispatchEvent(
    new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, button: 0, buttons: 1 })
  );
  element.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }));

  if (typeof element.focus === 'function') element.focus({ preventScroll: true });

  element.dispatchEvent(
    new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, button: 0, buttons: 0 })
  );
  element.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('click', { ...base, button: 0, detail: 1 }));
}

/**
 * What is actually on top of this element's centre point, if anything.
 *
 * Learned from the live site: the date picker renders directly over the SEARCH TRAINS button,
 * so a click dispatched at T0 would hit the calendar rather than the button. Returns null when
 * the element is genuinely on top (or is off-screen, where the question is meaningless).
 */
export function obstructingElement(element: HTMLElement): HTMLElement | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit) return null;
  if (hit === element || element.contains(hit) || hit.contains(element)) return null;
  return hit as HTMLElement;
}

/**
 * Make sure a click on `element` will actually reach it. Dismisses whatever is covering it the
 * way a user would, then re-checks. Returns the still-obstructing element, or null if clear.
 */
export async function ensureUnobstructed(element: HTMLElement): Promise<HTMLElement | null> {
  scrollIntoViewIfNeeded(element);

  let blocker = obstructingElement(element);
  if (!blocker) return null;

  element.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true })
  );
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  blocker = obstructingElement(element);
  return blocker;
}

/** Nearest ancestor (or self) that behaves like a button. */
export function clickTarget(element: HTMLElement): HTMLElement {
  const selector = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
  if (element.matches(selector)) return element;
  return (element.closest(selector) as HTMLElement | null) ?? element;
}
