# Page Analysis — Round 1 (screenshots only)

**Source:** 3 screenshots supplied 2026-08-15. **No HTML, no DOM, no URLs supplied yet.**

Everything in this document is read from pixels. Every selector is therefore `UNVERIFIED`
and no automation code will be written against it. Visual facts (element exists, is disabled,
has this label) are reliable; structural facts (id, class, tag, event model) are not.

---

## Cross-cutting observations

### O-1 — Seat selection exists and is mandatory
Screenshot 3 shows a coach dropdown, a 50-seat grid, a 4-state legend, a required boarding
station, and `CONTINUE PURCHASE`. **Seats are not auto-assigned.** This inverts the assumed
critical path: the race is not won at Search, it is won at seat selection. See §4.

### O-2 — "4 tickets" means "4 selected seats"
There is no quantity input anywhere in the search form. Ticket count is an emergent property of
how many seats are clicked. The 4-ticket requirement becomes: *select 4 seats, from one coach if
possible, across coaches if not.*

### O-3 — The page has live counters, i.e. constant background DOM churn
- Results page sidebar: `Total Active Users on this page: 1`
- Every train row: `0+ users are trying to book ticket(s)`
- Seat legend includes `In Progress` — seats other users are actively holding

These update without user action, which means polling or a socket, which means the DOM mutates
continuously during the exact window we care about. **Architectural consequence:** a
`MutationObserver` on `document` with `subtree: true` would fire constantly and burn CPU at
08:00:00. Observers must be scoped to the specific container being awaited. This is now a hard
design constraint, not a preference.

### O-4 — Class is chosen *before* search, yet results show all classes
The search form has `Choose Class`. But the expanded train in screenshot 2 shows **three** class
cards (`S_CHAIR`, `SNIGDHA`, `AC_B`) simultaneously. So the search-form class is probably a
filter/sort hint rather than a hard restriction. `UNVERIFIED — must confirm.`

**Why this matters enormously:** if all classes are always listed, class-priority fallback is a
*local* decision costing ~0 ms. If the search filters hard, falling back to a second class costs a
full round-trip re-search — the difference between winning and losing a seat.

### O-5 — Screenshots 2 and 3 are from different trains
Screenshot 2's expanded train `DHUMKETU EXPRESS (770)` departs Rajshahi **11:20 PM**.
Screenshot 3's boarding station reads `Rajshahi Station (06:40 AM) 16 Aug 2026`.
Different departure time ⇒ different train. I am therefore **not** assuming screenshot 3 is the
direct child of the class card in screenshot 2. The transition between them is `UNVERIFIED`.

### O-6 — Date shown in header vs. train card disagree
Results header reads `15-Aug-2026`; the DHUMKETU card reads `16 AUG, 11:20 PM` → `17 AUG, 04:40 AM`.
Either the header shows search date while cards show true departure date, or the screenshots span
sessions. `UNVERIFIED` — this must be resolved before any date-validation logic is written,
because booking the wrong day is an unrecoverable, paid-for error.

---

## PAGE A — Home / Search

**URL** `UNVERIFIED` — not supplied.
**PURPOSE** Session anchor + journey input + search submission.

### Important elements

| # | Purpose | Visible label / placeholder | Type (observed) | Notes |
|---|---|---|---|---|
| A1 | Session proof | `«ACCOUNT NAME»…` + chevron, top-right | Button/dropdown | Truncated with ellipsis ⇒ CSS truncation. **This is the login-state signal.** |
| A2 | Origin | label `From`, placeholder `From Station` | Text input | Almost certainly autocomplete — *not confirmed*, dropdown never captured open |
| A3 | Destination | label `To`, placeholder `To Station` | Text input | Same |
| A4 | Journey date | label `Date of Journey`, placeholder `Pick a date`, calendar icon at right | Text input + picker | Picker markup never captured open |
| A5 | Class | label `Choose Class`, value `Choose a Class` | **Native `<select>`** — renders the OS dropdown arrow | Native select ⇒ set `.value` + dispatch `change`, no click choreography |
| A6 | Submit | `SEARCH TRAINS` | Button | **Rendered disabled** — muted fill, low-contrast text. Enables once fields validate. |

### Selectors
`UNVERIFIED — all of them.` Screenshots contain zero structural information. Nothing can be
written until Snippet B output arrives.

### State transitions
`IDLE → SITE_DETECTED` on A1 present.
`SESSION_READY` on A1 containing a user name rather than a Login link.
`BOOKING_PAGE_READY` on A2–A6 all present.
`A6 disabled → enabled` is the gate for `ROUTE_READY + DATE_READY`.

### Automation actions
Fill A2, A3, A4, A5 → `waitForEnabled(A6)` → click A6.

### Possible failures
- A2/A3 are autocompletes that reject typed text unless a dropdown item is *clicked* — the single
  most common failure mode in this class of form. **Mitigation:** after filling, re-read the field
  and assert the committed value; if the site keeps a hidden station-code input, drive that instead.
- A4 refuses keyboard entry and demands the calendar widget.
- A6 never enables because a field was set via `.value` without firing the framework's event.

### Security checkpoints
None visible on this page.

---

## PAGE B — Search Results

**URL** `UNVERIFIED`. **PURPOSE** Train + class discovery and selection.

### Structure (observed)

Journey header — `Rajshahi - Dhaka`, `15-Aug-2026`, `PREV. DAY` (appears disabled/greyed),
`NEXT DAY`, `MODIFY SEARCH`.

Notice banner — *"Other users may be in the process of purchasing tickets at this moment. But in
case of payment failure, those tickets may become available time-to-time."*

**Train list is an accordion.** Rows are collapsed by default; each row shows train name + number
and a chevron. Only the clicked row expands. Observed rows:
`MADHUMATI EXPRESS (756)`, `BANALATA EXPRESS (792)`, `PADMA EXPRESS (760)`, `DHUMKETU EXPRESS (770)`.

> **Automation consequence:** the preferred train must be **expanded before** its classes are
> reachable. That is a mandatory extra click + DOM-render wait that was not in the original plan.
> Class availability is *not* readable while collapsed, so train-priority and class-priority cannot
> be evaluated in one pass — unless expansion is cheap enough to expand all candidates immediately.

Expanded row contains: departure `16 AUG, 11:20 PM` / `Rajshahi` — duration `05h 20m` —
arrival `17 AUG, 04:40 AM` / `Dhaka` — `Train Details` link — then a row of class cards.

### Class card anatomy (the parser target)

| Field | Example | Notes |
|---|---|---|
| Class name | `S_CHAIR`, `SNIGDHA`, `AC_B` | Machine-ish tokens — good, stable to match on |
| Fare | `৳450`, `৳863`, `৳1597` | Bengali Taka sign |
| Fare qualifier | `Including VAT` | Present on some cards only |
| Availability label | `Available Tickets (Counter + Online)` | Constant text |
| Availability count | `0` | **Numeric — this is the authoritative signal** |
| Card state | pink/red fill = sold out; a green-bordered card is partly visible at the bottom edge | Colour is corroborating evidence only |

### Availability mapping (proposed)
```
count >= requested (4)  → AVAILABLE
0 < count < 4           → LIMITED
count == 0              → SOLD_OUT
count unparseable       → UNKNOWN  ← never guess, never click
```
Parse the **number**, not the colour. Colour is a fallback tiebreaker, because a colour-only read
breaks under any theme change and is invisible to text-based tests.

`WAITLIST` from your spec: no evidence of a waitlist state on this site. Keeping the enum member,
leaving it unreachable until observed.

### Possible failures
- Expanding a train re-renders and invalidates cached node references → never cache across expand.
- The live "users are trying to book" counters mutate rows underneath us mid-parse.
- Availability count updates between parse and click → the click lands on a now-sold-out class.
  **Must be treated as expected, not exceptional:** verify after click, fall back to next priority.

---

## PAGE C — Seat Selection

**URL** `UNVERIFIED`. Panel vs. page vs. modal is `UNVERIFIED` — a `Close` link suggests overlay.
**PURPOSE** Choose specific seats, confirm boarding point, commit to purchase.

### Important elements

| # | Purpose | Observed | Notes |
|---|---|---|---|
| C1 | Coach selector | `Select Coach`, native-looking `<select>`, value `KHA - 0 Seat(s)` | **Option text embeds the free-seat count** — parse it and pick a coach with ≥4 without clicking through blindly |
| C2 | Legend | `Available` (white/outline), `Selected` (dark navy), `In Progress` (green), `Booked` (orange) | 4 states — the seat parser's ground truth |
| C3 | Seat grid | `KHA-1` … `KHA-50`, laid out 2 + aisle + 3 | All orange (Booked) in this capture |
| C4 | Seat details table | `Class` / `Seats` / `Fare`, empty | Populates on selection — a **verification signal** that a seat click actually registered |
| C5 | Total | `Total: ৳ 0` | Secondary confirmation |
| C6 | Note | `Child seat fare will be adjusted in the next page` | Confirms a passenger page follows |
| C7 | Boarding station | `Boarding Station *` — **required** — `Rajshahi Station (06:40 AM) 16 Aug 2026` | Appears pre-filled; must still be validated |
| C8 | Commit | `CONTINUE PURCHASE` | |
| C9 | Abort | `Close` | |

### This is the real bottleneck

At 08:00:00 the seat map is the contended resource. The flow is:
`pick coach → click 4 seats → each click is a server round-trip that may be rejected → continue`.

The `In Progress` state proves seats are **held by other users in real time**. Therefore:

- A seat that renders Available may be gone by the time our click lands. Rejection is the normal
  case, not an error path.
- After each click we must confirm via C4/C5 that the seat was actually granted, then move on.
- Selecting 4 seats requires up to 4 sequential confirmations. Sequential round-trips are the
  dominant cost in the whole booking — and **parallel clicking is not an option**: it would be both
  a server-hammering pattern and almost certainly rejected by the site's own hold logic.
- If a coach has fewer than 4 free seats, C1 must be re-driven to another coach, which re-renders
  the whole grid.

**Honest statement of limits:** extension-side latency here is a small fraction of total time.
Per-seat server confirmation dominates. The extension's job is to eliminate human reaction time
and dead waiting, not to make the server faster.

### Possible failures
- All coaches under 4 seats → must decide: take fewer, or fall back to next class/train. **This is
  a policy decision I need from you**, since it involves partially fulfilling your booking.
- Seat click silently fails (no C4 change) → retry once, then treat that seat as taken.
- `CONTINUE PURCHASE` pressed with fewer than 4 seats registered → must be blocked by a
  pre-submit assertion.
- Boarding station select is required and may not always be pre-filled.

---

## Flow model (revised)

```
Login  →  Home/Search  →  Results (accordion)
                              │  expand preferred train
                              ▼
                          Class cards  →  click class
                              │
                              ▼
                       Seat selection  ── coach select
                              │          ── click 4 seats (sequential, confirmed)
                              │          ── boarding station
                              ▼          ── CONTINUE PURCHASE
                     Passenger info  (UNVERIFIED — not supplied)
                              ▼
                     Security / OTP    (UNVERIFIED — not supplied)
                              ▼
                        Payment        (UNVERIFIED — not supplied)
                              ▼
                      Confirmation     (UNVERIFIED — not supplied)
```

---

## Blocking gaps

| Gap | Impact | Needed |
|---|---|---|
| **No HTML for any page** | No selector can be written. Nothing testable. | Snippet B on Pages A/B/C; Snippet C on one train card, one class card, the seat grid |
| No URLs | Cannot scope `host_permissions` or match content scripts | The URL of each page |
| Navigation type unknown | Decides whether state survives in memory or must persist to storage | Network tab observation on Search and on class-card click |
| Pages 4, 6, 7, 8 unseen | Half the state machine unimplementable | Screenshots + Snippet B |
| Pre-08:00 behaviour unknown | Booking-open detection cannot be built | Description of what the site shows before opening |
| Framework unknown | Decides how form input events must be dispatched | Snippet A |
