import { describe, expect, it, beforeEach } from 'vitest';
import { dateValueMatches, selectValue } from '@/content/form-filler';

/**
 * The date-format check exists because booking the wrong day is unrecoverable and already
 * paid for. The observed field format is "18-Aug-2026", but the check accepts any arrangement
 * of the same three parts rather than hard-coding one layout.
 */
describe('date commit verification', () => {
  it('accepts the format the site actually renders', () => {
    expect(dateValueMatches('18-Aug-2026', '2026-08-18')).toBe(true);
  });

  it('accepts other common arrangements of the same date', () => {
    expect(dateValueMatches('18 August 2026', '2026-08-18')).toBe(true);
    expect(dateValueMatches('2026-08-18', '2026-08-18')).toBe(true);
    expect(dateValueMatches('18/08/2026', '2026-08-18')).toBe(true);
  });

  it('rejects the right month but the wrong day', () => {
    expect(dateValueMatches('19-Aug-2026', '2026-08-18')).toBe(false);
    expect(dateValueMatches('16-Aug-2026', '2026-08-18')).toBe(false);
  });

  it('rejects the right day but the wrong month', () => {
    expect(dateValueMatches('18-Sep-2026', '2026-08-18')).toBe(false);
  });

  it('rejects the wrong year', () => {
    expect(dateValueMatches('18-Aug-2027', '2026-08-18')).toBe(false);
  });

  it('is not fooled by the day digits appearing inside the year', () => {
    // "20" must not be read out of "2026".
    expect(dateValueMatches('18-Aug-2026', '2026-08-20')).toBe(false);
  });

  it('handles single-digit days with and without padding', () => {
    expect(dateValueMatches('8-Aug-2026', '2026-08-08')).toBe(true);
    expect(dateValueMatches('08-Aug-2026', '2026-08-08')).toBe(true);
  });

  it('rejects an empty field', () => {
    expect(dateValueMatches('', '2026-08-18')).toBe(false);
  });
});

describe('dropdown selection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sets a native select and reports what was committed', async () => {
    document.body.innerHTML = `
      <label>Choose Class</label>
      <select id="cls">
        <option value="">Choose a Class</option>
        <option value="AC_B">AC_B</option>
        <option value="SNIGDHA">SNIGDHA</option>
        <option value="S_CHAIR">S_CHAIR</option>
      </select>`;
    const select = document.getElementById('cls') as HTMLSelectElement;

    const result = await selectValue(select, 'SNIGDHA');
    expect(result.ok).toBe(true);
    expect(select.value).toBe('SNIGDHA');
  });

  it('fires a change event so a framework notices', async () => {
    document.body.innerHTML = `
      <select id="cls"><option value="">-</option><option value="S_CHAIR">S_CHAIR</option></select>`;
    const select = document.getElementById('cls') as HTMLSelectElement;

    let changed = false;
    select.addEventListener('change', () => (changed = true));

    await selectValue(select, 'S_CHAIR');
    expect(changed).toBe(true);
  });

  it('reports failure instead of silently leaving the control unset', async () => {
    document.body.innerHTML = `
      <select id="cls"><option value="">-</option><option value="AC_B">AC_B</option></select>`;
    const select = document.getElementById('cls') as HTMLSelectElement;

    const result = await selectValue(select, 'NOT_A_REAL_CLASS', { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.note).toBeTruthy();
  });

  it('drives a custom widget by tapping it open and clicking the option', async () => {
    // A control that looks like a select but is not one - the case that needs a real tap.
    document.body.innerHTML = `
      <div id="host" tabindex="0">Choose a Class</div>
      <ul id="list" style="display:none">
        <li>AC_B</li><li>SNIGDHA</li><li>S_CHAIR</li>
      </ul>`;

    const host = document.getElementById('host') as HTMLElement;
    const list = document.getElementById('list') as HTMLElement;

    host.addEventListener('click', () => (list.style.display = 'block'));
    list.addEventListener('click', (event) => {
      const text = (event.target as HTMLElement).textContent ?? '';
      host.textContent = text;
      list.style.display = 'none';
    });

    const result = await selectValue(host, 'SNIGDHA');
    expect(result.ok).toBe(true);
    expect(host.textContent).toBe('SNIGDHA');
  });
});
