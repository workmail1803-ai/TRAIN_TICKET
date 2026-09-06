# API Capture — what I need to build the fast path

**Goal:** at 08:00:00, go straight to the seat-hold call instead of walking
`search → results render → expand train → click class → seat map render → click seat`.
Five or six round-trips collapse to about two.

**What does not change:** you log in yourself, you solve any CAPTCHA yourself, no credential is
ever stored, and you still press CONTINUE PURCHASE. The extension uses the session already in
your browser — same cookies, same endpoints the page itself calls.

---

## Why this is capturable in advance

Train and class identifiers are **stable between days**. `BANALATA EXPRESS (791)` Dhaka→Rajshahi
has the same id tomorrow as it does next week. So we resolve those ids the night before against a
date that already has tickets, cache them, and at 08:00 we already know exactly what to ask for.

That is the real speed win. Skipping rendering saves half a second; skipping three round-trips
saves much more.

---

## ⚠️ Redact the token — I need shapes, not secrets

Some request will carry an auth value: `Authorization: Bearer eyJhb...`, or a session cookie, or
an `x-auth-token` header. **I need to know it exists and what it is called. I must never see its
value.**

Replace it before sending:

```
Authorization: Bearer «REDACTED»
```

Same for anything that looks like a session id, a device id, or your mobile number. If in doubt,
X it out — I can always ask for the shape of a field, and I can never un-see a token.

---

## Setup

1. Open the Railway site, logged in.
2. `F12` → **Network** tab.
3. Tick **Preserve log**.
4. Filter to **Fetch/XHR** (the button row under the search box).
5. Use a date that **already has tickets** — do not wait for 08:00 for this.

To copy a request: right-click the row → **Copy** → **Copy as fetch**. That gives URL, method,
headers and body in one paste. Redact the token, then send it.

---

## The four requests I need

### 1. Search

Fill the form, click **SEARCH TRAINS**, and find the XHR that carries the journey.

- Copy as fetch (redacted)
- Plus the **response**: right-click the row → Copy → Copy response. If it is large, I mainly need
  the shape — one complete train object with its class/availability children is enough.

What I am looking for: how a train is identified (`trip_id`? `train_id`?) and how a class is
identified inside it.

### 2. Open the seat map

Click a green **BOOK NOW**. Capture the request it fires.

- Copy as fetch (redacted)
- Response: the seat list. One complete seat object is enough — I need to see how a seat's
  identity and its state (available / booked / in progress) are expressed.

### 3. Hold one seat — **the critical one**

Click a **single** available seat. Capture that request.

- Copy as fetch (redacted)
- Response, complete

This is the request the whole rewrite is built around. If I get nothing else, get this.

### 4. Release the seat

Click the same seat again to deselect it. Capture that request too — the extension must be able to
undo a hold cleanly if it grabs the wrong seat or you press STOP.

---

## Where the auth lives

Run this in the **Console** and paste the output. It prints key **names** only, never values:

```js
copy(JSON.stringify({
  localStorage: Object.keys(localStorage),
  sessionStorage: Object.keys(sessionStorage),
  cookieNames: document.cookie.split(';').map(c => c.split('=')[0].trim()),
}, null, 2));
```

If a key is obviously the token (`token`, `access_token`, `authInfo`), tell me the name and
roughly what the value looks like — "a long JWT", "a 32-char hex string" — and nothing more.

---

## Design constraints for the implementation

Recording these now so they are not lost later:

- **Seat holds stay sequential.** Four concurrent hold requests would likely be rejected anyway,
  and it is exactly the pattern that gets an account flagged. One at a time, each confirmed.
- **The DOM path stays as fallback.** If any API call returns an unexpected shape, the engine
  falls back to the existing click-driven flow rather than failing the morning. An API contract
  that changes silently is the main risk of this whole approach, and the fallback is the answer.
- **Ids are cached, then re-validated.** A cached train id that no longer resolves must be
  detected at ARM, not at 08:00.
- **No new permissions.** Requests go from the content script to the same origin the extension is
  already allowed on.
- **The purchase call is never made.** As now, automation stops with seats held.

---

## If the seats are genuinely all held at 08:00

Worth deciding before building. If the seat map comes back with everything already `In Progress`
within the first second, speed is not the winning variable — persistence is. Holds expire, and
payments fail; the site says so itself. A patient watcher that claims the instant a hold lapses
plays a race that can actually be won, and needs none of this.

The two are not exclusive, but if only one gets built, the 8am log should decide which.
