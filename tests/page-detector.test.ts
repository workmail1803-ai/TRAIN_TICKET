import { describe, expect, it, beforeEach } from 'vitest';
import { detectPage, detectSession } from '@/content/page-detector';

/**
 * Regression tests for a false positive found on the live site: the home page hero reads
 * "Easy purchase of tickets using online payment method" and sits above a bKash / Nagad /
 * Rocket / VISA logo strip, plus a "Pay" feature blurb. The first version of the detector
 * checked payment text before structural evidence and reported the home page as the payment
 * stage, which blocked arming entirely.
 */

const HERO_COPY = 'Easy purchase of tickets using online payment method';

function homePage(): string {
  return `
    <header>
      <nav>
        <a>Home</a><a>Verify Ticket</a><a>Train Information</a><a>Contact Us</a>
      </nav>
      <button class="dropdown-toggle">EXAMPLE ACCOUNT NAME</button>
    </header>
    <main>
      <div class="hero">${HERO_COPY}</div>
      <form>
        <label>From</label><input placeholder="From Station" />
        <label>To</label><input placeholder="To Station" />
        <label>Date of Journey</label><input placeholder="Pick a date" />
        <label>Choose Class</label>
        <select><option>Choose a Class</option><option>S_CHAIR</option></select>
        <button>SEARCH TRAINS</button>
      </form>
      <section>
        <h3>Search</h3><p>Choose your origin, destination, journey dates and search for trains</p>
        <h3>Select</h3><p>Select your desired trip and choose your seats</p>
        <h3>Pay</h3><p>Pay for the tickets via Debit / Credit Cards or MFS</p>
      </section>
    </main>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('home page detection', () => {
  it('reports HOME despite the hero copy mentioning "online payment method"', () => {
    document.body.innerHTML = homePage();
    const detected = detectPage(location.origin);
    expect(detected.kind).toBe('HOME');
    expect(detected.confident).toBe(true);
  });

  it('is not tripped by the "Pay" feature blurb further down the page', () => {
    document.body.innerHTML = homePage();
    expect(document.body.textContent).toContain('Pay for the tickets');
    expect(detectPage(location.origin).kind).toBe('HOME');
  });

  it('recognises the logged-in session from the header control', () => {
    document.body.innerHTML = homePage();
    const session = detectSession();
    expect(session.loggedIn).toBe(true);
    expect(session.displayName).toContain('EXAMPLE');
  });

  it('reports a logged-out session when a login link is present instead', () => {
    document.body.innerHTML = `
      <header><nav><a>Home</a></nav><a href="/login">Login</a></header>`;
    expect(detectSession().loggedIn).toBe(false);
  });
});

describe('payment detection', () => {
  it('fires on an actual payment control when no structural page signal exists', () => {
    document.body.innerHTML = `
      <main><h2>Order summary</h2><button>PROCEED TO PAYMENT</button></main>`;
    const detected = detectPage(location.origin);
    expect(detected.kind).toBe('PAYMENT');
  });

  it('treats leaving the site origin as entering the gateway', () => {
    document.body.innerHTML = '<main>Redirecting…</main>';
    expect(detectPage('https://some-other-origin.example').kind).toBe('PAYMENT');
  });

  it('ignores wallet brand names in ordinary page text', () => {
    document.body.innerHTML = `
      <main><p>Pay with bKash, Nagad, Rocket or Upay. Mobile banking supported.</p></main>`;
    expect(detectPage(location.origin).kind).not.toBe('PAYMENT');
  });
});

describe('security detection outranks everything', () => {
  it('reports SECURITY even when the search form is present', () => {
    document.body.innerHTML = homePage() + '<div class="g-recaptcha"></div>';
    expect(detectPage(location.origin).kind).toBe('SECURITY');
  });
});
