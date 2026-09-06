# Network Findings — captured from the live site

**Captured 2026-09-06** by driving a logged-in Chrome tab and reading the network log on
`Dhaka → Rajshahi, 09-Sep-2026, SNIGDHA`. Everything here is **observed**, not inferred.

These findings invalidate several assumptions the extension was built on. Read this before
touching the booking path.

---

## F-1 — Search is a plain URL, server-rendered

Clicking SEARCH TRAINS performs a full page navigation to:

```
https://eticket.railway.gov.bd/booking/train/search
    ?fromcity=Dhaka&tocity=Rajshahi&doj=09-Sep-2026&class=SNIGDHA
```

No XHR. No JSON API. The results are server-rendered HTML.

`doj` uses the same `DD-Mon-YYYY` format the date field displays.

**Consequence:** the entire form-filling apparatus — station autocompletes, the calendar widget,
the class `<select>`, waiting for the submit button to enable — is unnecessary. The journey is
fully expressible as a URL that can be built the night before.

## F-2 — One response contains the whole booking surface

That single HTML response carries **all** of:

- every train on the route, with number
- every class card, fare, and availability count
- the coach list with per-coach free-seat counts
- **every coach's full seat map, with per-seat state**

Verified by clearing the network log and then performing each action:

| Action | Requests fired |
|---|---|
| Click `BOOK NOW` | none (one decorative SVG) |
| Switch coach in the dropdown | none |
| Click a seat | none (one Facebook pixel) |
| Deselect a seat | none |

## F-3 — Selecting a seat does NOT hold it server-side

This is the finding that most changes the design. Seat clicks are pure DOM state. Nothing is
reserved at click time.

**The earlier analysis in the README was wrong.** It claimed "four sequential seat confirmations
dominate a real booking and no browser extension can shorten them". There are no per-seat server
calls at all. Selecting four seats is instant and local.

**Where the race actually is:** the only contended server interaction before payment is
`CONTINUE PURCHASE`. Whoever POSTs a valid seat set first wins. That also explains seats showing
`In Progress` in bulk at 08:00 — those are people who already got through CONTINUE PURCHASE and
are sitting in the passenger/payment flow.

## F-4 — Seat state is an explicit CSS class

No colour matching is required. Observed on `button.btn-seat`:

| Class | Meaning | Count in sample |
|---|---|---|
| `btn-seat seat-available` | free | 10 — exactly matching "JA - 10 Seat(s)" |
| `btn-seat seat-booked` | taken | 70 |
| `btn-seat seat-selected seat-available` | **ours, after clicking** | 1 |
| `btn-seat seat-hidden seat-booked` | aisle spacer, empty label | 22 |
| `seat-in-progress` (name unverified) | held by another user | none present in sample |

> ### ⚠️ A selected seat KEEPS `seat-available`
>
> `classifyByHints` tests SELECTED before AVAILABLE and therefore returns the right answer — but
> only because of that ordering. Reverse the two and a seat we just claimed reads as free, gets
> clicked again, and is **deselected**. The order is load-bearing and must stay covered by a test.

Spacer seats carry an empty label, so the `^[A-Z]+-\d+$` label filter already excludes them.

## F-5 — The site is Angular

`ng-star-inserted` and `_ngcontent-*` attributes throughout. Previously `UNVERIFIED`.
Server-rendered, then hydrated.

## F-6 — The 4-seat limit is stated on the page

> "Choose your seat(s) ** Maximum 4 seats can be booked at a time."

Also: "To know seat number(s), rest the cursor on your desired seat(s)" — seat numbers are
rendered as hover tooltips, which is why an earlier screenshot showed one floating over the grid.

## F-7 — Station fields are autocompletes (confirmed)

Typing "Dhaka" opens a suggestion list containing `Dhaka` and `Dhaka Cantonment`; the entry must
be chosen from it. Previously handled defensively on the assumption it might be needed — it is.
Moot if F-1 is adopted, since the form is bypassed entirely.

## F-8 — Rows are not always collapsed

On this route the class cards were rendered expanded, with no accordion click needed. Earlier
captures on a different route showed collapsed rows. Both shapes occur; `expandTrain` must keep
handling both, and must not assume a click is required.

---

## What this means for the 08:00 path

The optimal sequence is now only **two server interactions**:

```
T0   GET /booking/train/search?...        ← one request, everything arrives
     parse HTML, pick train + class       ← local, sub-millisecond
     select 4 seats                       ← local, no requests
     POST continue purchase               ← the only contended call
```

The remaining optimisation is to `fetch()` the search URL and parse the returned HTML string
rather than navigating and letting Angular render it — that skips hydration entirely.

**No API reverse-engineering is needed, and no server-side bot would help.** There is no private
JSON API on the read path to call; there is one HTML GET that any logged-in browser can issue.
