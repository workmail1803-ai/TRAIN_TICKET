# Capture Checklist — what to send, and how to get it from DevTools

Everything below is captured from **your own logged-in browser session**. Nothing here touches
CAPTCHA tokens, OTP, passwords, or payment data — those are explicitly excluded (see §5).

Open DevTools with `F12` (or `Ctrl+Shift+I`). Two panels matter:

- **Elements** — the DOM tree. Right-click any node → Copy → Copy outerHTML.
- **Console** — where you paste the snippets below.

> If Chrome refuses your first paste into Console, it will ask you to type `allow pasting`
> and press Enter. Do that once per site, then paste normally.

---

## 1. The three snippets

Run these on **each** page listed in §3. Each one ends with `copy(...)`, which puts the result
straight on your clipboard — then just paste it to me.

### Snippet A — Page probe (run first, on every page)

Tells me the URL, the framework, and how the page is built. This replaces guessing.

```js
(() => { const o = { url: location.href, title: document.title, readyState: document.readyState };
try { o.next = !!document.getElementById('__NEXT_DATA__'); } catch(e){}
try { o.nuxt = typeof window.__NUXT__ !== 'undefined'; } catch(e){}
try { o.angular = !!document.querySelector('[ng-version]'); } catch(e){}
try { o.vue = !!document.querySelector('[data-v-app]') || typeof window.Vue !== 'undefined'; } catch(e){}
try { const d = document.querySelector('body div'); o.react = !!d && Object.keys(d).some(k => k.startsWith('__react')); } catch(e){}
try { o.jquery = window.jQuery ? window.jQuery.fn.jquery : false; } catch(e){}
try { o.forms = [...document.forms].map(f => ({ id: f.id, name: f.name, action: f.action, method: f.method })); } catch(e){}
try { o.scripts = [...document.scripts].map(s => s.src).filter(Boolean).slice(0, 30); } catch(e){}
copy(JSON.stringify(o, null, 2)); console.log(o); })()
```

### Snippet B — Element inventory (the most useful one)

Lists every interactive element with all its selector-worthy attributes. **It deliberately does
not read input values**, so your personal data does not leave the page.

```js
copy(JSON.stringify([...document.querySelectorAll('input,select,textarea,button,a,label,[role],[onclick]')]
  .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map(el => { const t = el.tagName.toLowerCase(); const isField = t === 'input' || t === 'select' || t === 'textarea';
    return { tag: t, type: el.getAttribute('type') || '', id: el.id || '',
      name: el.getAttribute('name') || '', role: el.getAttribute('role') || '',
      aria: el.getAttribute('aria-label') || '', placeholder: el.getAttribute('placeholder') || '',
      cls: (el.className || '').toString().slice(0, 140),
      data: Object.keys(el.dataset || {}).map(k => k + '=' + el.dataset[k]).join(' ').slice(0, 140),
      text: isField ? '' : (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 70),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      href: t === 'a' ? (el.getAttribute('href') || '').slice(0, 100) : '' }; }), null, 1));
```

### Snippet C — Redacted HTML of one region

Use this when I ask for "the HTML of a train result card" or "the passenger form".

1. In the **Elements** panel, click the element you want (its container, not the whole page).
2. Run this in Console. `$0` means "the node I just selected".

```js
(() => { const r = $0.cloneNode(true);
r.querySelectorAll('script,style,noscript,svg,iframe,img,path').forEach(n => n.remove());
r.querySelectorAll('input,textarea').forEach(el => { if (el.hasAttribute('value')) el.setAttribute('value', 'REDACTED'); });
copy(r.outerHTML); console.log('copied', r.outerHTML.length, 'chars'); })()
```

Keep the selection **tight**. One train card, not the whole results table. If the card is 400
lines of nested wrappers, that is fine — I need the nesting. If it is 40,000 lines, you selected
too high up.

---

## 2. The one thing HTML cannot tell me: navigation type

This single fact changes the whole automation core, and only you can observe it.

Open the **Network** tab, tick **Preserve log**, then click the button in question and watch:

- A new **document** request appears, page white-flashes → **full navigation**
  (automation must survive a page teardown and resume from storage).
- Only **fetch/xhr** rows appear, page updates in place → **AJAX/SPA**
  (automation stays alive; uses MutationObserver).

Report this for each of these clicks: **Search**, **Select train/class**, **Continue from
passenger page**, **Proceed to payment**.

---

## 3. What to send, page by page

For every page: **Snippet A + Snippet B + a screenshot**. Then the extras below.

| # | Page | Extras needed (Snippet C on these regions) |
|---|------|--------------------------------------------|
| 1 | Login | The logged-**in** header/user menu — I need a signal that proves a live session, and the URL you get redirected to after login. **No credentials.** |
| 2 | Booking / search form | The whole search form container. If origin/destination are autocomplete dropdowns, open one and capture the **open dropdown list**. Same for the date picker — capture it **open**. Also: the ticket-quantity control and its max value. |
| 3 | Search results | (a) one **available** train card, (b) one **sold-out** card, (c) the results container. Plus screenshots of both states. This is the highest-value capture in the whole project. |
| 4 | Passenger info | The full form for **one** passenger row, plus the container holding all 4. Note which fields are required (the ones that error when blank). Fill it with **fake data** for the capture if you prefer. |
| 5 | Seat selection | Only if it exists. If seats are auto-assigned, just tell me — I will not build seat automation you do not need. If it exists: an available seat, a taken seat, a selected seat. |
| 6 | Security check | Screenshot + Snippet C on the container **around** the CAPTCHA. I need to *detect* it, nothing more. Do not send tokens, images, or the iframe internals. |
| 7 | Payment | Screenshot of the **entry point** only (the button that leaves the site / the gateway landing). Nothing past it. Plus the URL you land back on after returning. |
| 8 | Confirmation | Screenshot + Snippet C on the block containing the booking reference. **Blur or replace the reference and passenger names.** I only need where it lives in the DOM, not its value. |

---

## 4. Timing facts I need (from you, in plain words)

- The exact site behaviour before 08:00 — is the search button disabled, does the site show a
  countdown, does it show an error, or does it look normal but return "not available"?
- Does the site put you in a **queue / waiting room** at peak? If so, screenshot it.
- The stated maximum tickets per booking for your account.
- Whether the booking date window is fixed (e.g. always 10 days ahead).

---

## 5. Do NOT send me

- Passwords, or any screenshot showing one
- OTP codes, card numbers, CVV, mobile-banking PINs
- CAPTCHA tokens or solved-challenge payloads
- Your real NID, full phone number, or booking reference — replace with `X`s

Before you paste anything, skim it once. Snippet B never reads input values and Snippet C blanks
`value` attributes, but a page can still render your name or phone as plain text somewhere in the
markup. Overwrite those by hand.

---

## 6. Order of delivery

Send **Page 1 + Page 2 first**. That is enough for me to start Phase 2 (extension foundation) and
Phase 3 (arming/preparation) while you capture the rest. Page 3 next — it gates the hardest part
of the build. Pages 6–8 can come last.
