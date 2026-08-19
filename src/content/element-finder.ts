import type { ElementDescriptor } from '@/selectors/railway-selectors';
import { logger } from '@/utils/logger';

/**
 * Element resolution engine.
 *
 * Priority, per spec:
 *   1 id -> 2 name -> 3 aria-label -> 4 associated label -> 5 semantic attrs
 *   -> 6 stable class -> 7 text -> 8 relative structure
 *
 * Structural hints (id, name, class) are UNVERIFIED for this site - no HTML has been
 * supplied - so in practice tiers 4, 5 and 7 do the real work. That is deliberate: labels,
 * placeholders and button text ARE verified from the screenshots, and they survive the
 * class-name churn that a framework rebuild would cause.
 */

export function normText(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Text of an element, for scanning.
 *
 * Uses textContent, NOT innerText. innerText is layout-dependent: reading it forces a reflow,
 * and a scan across thousands of elements at 08:00 would thrash layout thousands of times.
 * textContent is a pure tree read. Visibility is filtered separately, by the caller.
 */
export function elementText(el: Element): string {
  return normText(el.textContent ?? '');
}

/** Direct text of an element, excluding descendants' text. Useful for accordion headers. */
export function ownText(el: Element): string {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
  }
  return normText(out);
}

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Cheap attribute checks before anything that forces style computation.
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

export function isEnabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true) return false;
  if (el.hasAttribute('disabled')) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  // Sites often express "disabled" on a styled <a> or <div> with a class.
  const cls = normText(el.className?.toString?.() ?? '');
  if (/\bdisabled\b/.test(cls)) return false;
  return true;
}

function unique(elements: Element[]): HTMLElement[] {
  const seen = new Set<Element>();
  const out: HTMLElement[] = [];
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    out.push(el);
  }
  return out;
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    // A malformed override selector must not take the run down.
    logger.warn(`Ignored invalid selector: ${selector}`);
    return [];
  }
}

function matchesTag(el: Element, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  return tags.includes(el.tagName.toLowerCase());
}

// ---------------------------------------------------------------------------
// Tier 4 - associated label
// ---------------------------------------------------------------------------

/**
 * Resolve the control a <label> refers to. Handles the three real-world arrangements:
 * `for=` pointing at an id, the control nested inside the label, and the label sitting
 * immediately above the control inside a shared form-group wrapper (which is what the
 * supplied screenshots show).
 */
function controlsForLabel(label: HTMLLabelElement, tags?: string[]): Element[] {
  const found: Element[] = [];

  const forId = label.getAttribute('for');
  if (forId) {
    const byId = label.ownerDocument.getElementById(forId);
    if (byId) found.push(byId);
  }

  if (label.control) found.push(label.control);
  found.push(...queryAll(label, 'input, select, textarea'));

  // Label above control inside a shared wrapper.
  let container: Element | null = label.parentElement;
  for (let depth = 0; container && depth < 3; depth++) {
    const controls = queryAll(container, 'input, select, textarea');
    if (controls.length > 0) {
      found.push(...controls);
      break;
    }
    container = container.parentElement;
  }

  // Immediate siblings, for markup with no wrapper at all.
  let sibling = label.nextElementSibling;
  for (let i = 0; sibling && i < 3; i++) {
    if (['input', 'select', 'textarea'].includes(sibling.tagName.toLowerCase())) {
      found.push(sibling);
      break;
    }
    const nested = queryAll(sibling, 'input, select, textarea');
    if (nested.length > 0) {
      found.push(...nested);
      break;
    }
    sibling = sibling.nextElementSibling;
  }

  return found.filter((el) => matchesTag(el, tags));
}

function findByLabelText(root: ParentNode, labelTexts: string[], tags?: string[]): Element[] {
  const wanted = labelTexts.map(normText);
  const out: Element[] = [];

  for (const label of queryAll(root, 'label')) {
    const text = normText(label.textContent).replace(/\s*\*\s*$/, ''); // drop required asterisk
    if (!wanted.some((w) => text === w || text.startsWith(w + ' ') || text === w + ':')) continue;
    out.push(...controlsForLabel(label as HTMLLabelElement, tags));
  }

  // Some markup uses a plain element rather than <label>.
  if (out.length === 0) {
    for (const candidate of queryAll(root, 'div, span, p, strong, b, h4, h5, h6')) {
      if (candidate.children.length > 0) continue;
      const text = normText(candidate.textContent).replace(/\s*\*\s*$/, '');
      if (!wanted.includes(text)) continue;

      let container: Element | null = candidate.parentElement;
      for (let depth = 0; container && depth < 3; depth++) {
        const controls = queryAll(container, 'input, select, textarea').filter((el) =>
          matchesTag(el, tags)
        );
        if (controls.length > 0) {
          out.push(...controls);
          break;
        }
        container = container.parentElement;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tier 7 - text
// ---------------------------------------------------------------------------

const CLICKABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"]';

/**
 * Find elements whose own text matches. Prefers the innermost match, then walks up to the
 * nearest clickable ancestor, so "SEARCH TRAINS" wrapped in a <span> inside a <button>
 * still resolves to the button.
 */
export function findByText(
  root: ParentNode,
  texts: string[],
  options: { exact?: boolean; tags?: string[]; clickable?: boolean } = {}
): HTMLElement[] {
  const wanted = texts.map(normText).filter(Boolean);
  if (wanted.length === 0) return [];

  const scanSelector = options.tags?.length
    ? options.tags.join(', ')
    : 'button, a, input, div, span, li, td, th, h1, h2, h3, h4, h5, h6, p, label, strong';

  const matches: HTMLElement[] = [];

  for (const el of queryAll(root, scanSelector)) {
    if (!(el instanceof HTMLElement)) continue;

    let text = elementText(el);
    if (el instanceof HTMLInputElement && !text) text = normText(el.value);

    const hit = options.exact === false
      ? wanted.some((w) => text.includes(w))
      : wanted.some((w) => text === w);
    if (!hit) continue;

    // Prefer the innermost element carrying this text.
    const deeper = matches.some((m) => el.contains(m));
    if (deeper) continue;
    matches.push(el);
  }

  if (!options.clickable) return unique(matches);

  return unique(
    matches.map((el) => {
      if (el.matches(CLICKABLE)) return el;
      const ancestor = el.closest(CLICKABLE);
      return (ancestor as HTMLElement | null) ?? el;
    })
  );
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export interface FindOptions {
  root?: ParentNode;
  /** Require the element to be visible. Default true. */
  visible?: boolean;
  /** Require the element to be enabled. Default false - callers wait for enable explicitly. */
  enabled?: boolean;
}

/** All candidates for a descriptor, in priority order, best first. */
export function findAll(descriptor: ElementDescriptor, options: FindOptions = {}): HTMLElement[] {
  const root = options.root ?? document;
  const wantVisible = options.visible !== false;
  const tiers: Element[][] = [];

  // 1. id
  if (descriptor.id) {
    const byId = (root as Document).getElementById?.(descriptor.id) ?? null;
    tiers.push(byId ? [byId] : queryAll(root, `#${CSS.escape(descriptor.id)}`));
  }

  // 2. name
  if (descriptor.name) {
    tiers.push(queryAll(root, `[name="${CSS.escape(descriptor.name)}"]`));
  }

  // 3. aria-label
  if (descriptor.ariaLabel) {
    tiers.push(queryAll(root, `[aria-label="${CSS.escape(descriptor.ariaLabel)}"]`));
  }

  // 4. associated label
  if (descriptor.labelText?.length) {
    tiers.push(findByLabelText(root, descriptor.labelText, descriptor.tag));
  }

  // 5. semantic attributes
  if (descriptor.placeholder?.length) {
    tiers.push(
      descriptor.placeholder.flatMap((p) => queryAll(root, `[placeholder="${CSS.escape(p)}"]`))
    );
    // Placeholder text can drift in case/spacing; fall back to a scan.
    tiers.push(
      queryAll(root, 'input, textarea').filter((el) =>
        descriptor.placeholder!.some(
          (p) => normText(el.getAttribute('placeholder')) === normText(p)
        )
      )
    );
  }
  if (descriptor.role) {
    tiers.push(queryAll(root, `[role="${CSS.escape(descriptor.role)}"]`));
  }

  // 6. stable class / last-resort CSS
  if (descriptor.css?.length) {
    for (const selector of descriptor.css) tiers.push(queryAll(root, selector));
  }

  // 7. text
  if (descriptor.text?.length) {
    tiers.push(findByText(root, descriptor.text, { tags: descriptor.tag, clickable: true }));
  }
  if (descriptor.textContains?.length) {
    tiers.push(
      findByText(root, descriptor.textContains, {
        exact: false,
        tags: descriptor.tag,
        clickable: true,
      })
    );
  }

  // 8. relative structure - tag alone, only when nothing else was specified.
  const hasAnyHint =
    descriptor.id ||
    descriptor.name ||
    descriptor.ariaLabel ||
    descriptor.labelText?.length ||
    descriptor.placeholder?.length ||
    descriptor.role ||
    descriptor.css?.length ||
    descriptor.text?.length ||
    descriptor.textContains?.length;
  if (!hasAnyHint && descriptor.tag?.length) {
    tiers.push(queryAll(root, descriptor.tag.join(', ')));
  }

  for (const tier of tiers) {
    const candidates = unique(tier)
      .filter((el) => matchesTag(el, descriptor.tag))
      .filter((el) => (wantVisible ? isVisible(el) : true))
      .filter((el) => (options.enabled ? isEnabled(el) : true));
    if (candidates.length > 0) return candidates;
  }

  return [];
}

export function findOne(descriptor: ElementDescriptor, options: FindOptions = {}): HTMLElement | null {
  const all = findAll(descriptor, options);
  if (all.length > 1) {
    logger.warn(
      `${descriptor.key}: ${all.length} candidates matched, using the first`,
      all
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`)
        .join(', ')
    );
  }
  return all[0] ?? null;
}

/** True when a cached handle is still usable. Cheap guard against stale references. */
export function isAlive(el: Element | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && el instanceof HTMLElement;
}
