# Bangladesh Railway QuickBook

A Manifest V3 Chrome extension that prepares a Bangladesh Railway ticket booking **before** the
08:00 (Asia/Dhaka) sales window opens, then drives the site's normal booking flow the moment it
does — search, train, class, seat map — and **stops with the seats selected** so a human commits
the purchase.

Written in TypeScript for a single legitimate account and the ticket limit that account already
has. It removes human reaction time and dead waiting. It does not, and cannot, make the server
faster.

---

## What it will never do

Not as a setting, not as a flag — these are absent by construction:

- **Press CONTINUE PURCHASE.** Automation ends once seats are selected. No code path resolves or
  clicks that button, and the state machine cannot reach a commit state from `SEATS_CONFIRMED`.
  Guarded by tests at both levels.
- Solve, read, forward, store or bypass a CAPTCHA, OTP or any security check
- Store or type payment credentials, or automate payment authentication
- Attempt more tickets than the account is allowed
- Refresh in a loop, fire concurrent requests, or touch a private endpoint

When a verification or payment step appears, automation **stops** and hands over the page.
Passwords, card numbers, CVV, OTP codes and CAPTCHA tokens have no field in the storage schema,
and the logger runs a redaction pass before anything is written.

---

## Quick start

```bash
npm install
npm run build
```

Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.

Open the Railway site. A dark green bar pinned to the top of the page means the content script
attached. No bar means the host pattern does not match — see below.

### Host

`https://eticket.railway.gov.bd/*`, set in `public/manifest.json`. If it ever changes, update it
in **two places** there (`host_permissions` and `content_scripts[0].matches`) plus
`SITE.originHint` in `src/selectors/railway-selectors.ts`, then rebuild.

After any rebuild: click **↻** on the extension card, **and** reload the Railway tab — content
scripts do not re-inject into pages that are already open.

---

## How it is used

| When | Who | What |
|---|---|---|
| Night before | You | **Settings** → route, date, train priority 1–3, class priority 1–3, four passenger profiles. Stored locally, permanently. |
| ~07:45 | You | Open the site and **log in yourself**. The extension never sees credentials. |
| ~07:50 | You | Press **ARM** in the popup. |
| 07:50–08:00 | Extension | Validates config, syncs its clock to the server, **pre-fills the search form**, waits. |
| 08:00:00 | Extension | Fires the search, walks train and class priority in strict order, opens the seat map, claims seats. |
| Seats selected | Extension | **Stops.** You press CONTINUE PURCHASE. |
| CAPTCHA / OTP | Extension | Stops. You solve it, press **CONTINUE**. |
| Payment | Extension | Stops. You pay. It then watches only for the confirmation page. |

Three things that matter:

1. **Logging in does not start a booking.** ARM is the consent step — without it the extension
   would be spending real money on a route and date it had to guess.
2. **It refuses to arm** when anything is missing. Failing at 07:50 with "Passenger 3 has no age"
   is the entire point; discovering it at 08:00:00.4 is a lost booking.
3. **Keep the tab in the foreground.** Chrome throttles timers in background tabs. The popup and
   the on-page banner both warn about this.

**STOP** is always available: the popup button, the banner button, or `Esc`. A **GO NOW** button
skips the countdown, for dry runs or when booking is already open.

---

## What the site actually does

Facts established from screenshots and live runs. They shaped the whole design:

- **Seat selection is mandatory.** Seats are not auto-assigned. "4 tickets" means clicking four
  individual seats, each a separate server round-trip that can be refused. The seat map — not the
  search — is where the booking is won or lost.
- **`BOOK NOW` is the availability signal.** A class card renders that button only when it is
  actually bookable; sold-out cards render nothing. Far more reliable than parsing a count or a
  colour, so it is the primary check.
- **The coach dropdown carries free-seat counts** — `KHA - 0 Seat(s)`, `JHA - 2 Seat(s)`. Scanning
  every coach is a pure read of the `<select>` options: no clicks, no re-renders.
- **The Seat Details table is the source of truth** for what you hold. Local click bookkeeping can
  be wrong in both directions — a slow grant looks like a refusal, a colour read can mislead — so
  every count is reconciled against the site's own summary.
- **Selecting a seat makes no server call.** Seat state is client-side until CONTINUE PURCHASE;
  that submit is the only contended request before payment. Seat state is expressed as explicit
  CSS classes (`seat-available` / `seat-booked` / `seat-selected`), so no colour matching is
  needed. See [`docs/04-network-findings.md`](docs/04-network-findings.md).
- **`SEARCH TRAINS` is enabled at all times.** A search sent before the date is released does not
  fail; it returns *"No train found for selected dates or cities."* This is the single most
  important quirk in the project — see [Timing](#timing).
- **Results are an accordion.** Class cards do not exist until a row is expanded.
- **The page mutates constantly on its own** — live "N users are trying to book" and "Total Active
  Users" counters. Every `MutationObserver` is scoped to a specific container; a document-wide one
  would fire nonstop at precisely the wrong moment.
- **The calendar only enables a rolling ~10-day window.** Disabled days are never clicked — if the
  requested date is not selectable the run stops rather than booking the wrong day.

---

## Field notes

Bugs that only appeared against the live site. Each is now covered by a regression test.

**Never judge a page on its first paint.** The results list renders progressively. The engine
parsed it *once*, the instant any row appeared, and reported a preferred train as "not in the
results" while it sat on screen a fraction of a second later. Both the train list and the class
cards now wait, bounded, for what they are looking for.

**The extension stopped itself.** Dismissing the date picker dispatches a synthetic `Escape`,
which bubbled to the emergency-stop listener. Now gated on `event.isTrusted` — `false` for
synthetic events, `true` only for a real key press.

**Structural evidence must outrank text.** The home page hero reads *"…using online payment
method"* above a bKash/Nagad/VISA logo strip, so a text-first page detector labelled the home page
as the payment stage and blocked arming entirely. Page detection now checks for the search form,
results rows and seat panel before any text heuristic runs.

**A "calendar" class is not a calendar.** Matching `[class*="calendar"]` resolved in 4 ms to the
icon inside the date field. The picker is now located by content — a `Su…Sa` weekday row plus a
grid of day numbers — which an icon cannot fake.

**One representative per class group is not enough.** The seat classifier grouped seats by class
name and measured one per group, giving an entire 50-seat grid a single verdict. It claimed one
seat from a coach advertising twenty free. Every seat is now measured individually.

**A committed purchase is not the bot's to make.** An early version, when short of the target,
warned and clicked CONTINUE PURCHASE anyway — carrying a single seat into the purchase flow. That
path no longer exists at any level.

---

## Timing

Two independent error sources, and only one is under the extension's control.

**Timer accuracy — solved.** The countdown chains timers to T-4 ms, then busy-waits on
`performance.now()`. `setTimeout` cannot resolve finer than a few milliseconds and may fire late;
`requestAnimationFrame` is worse, landing up to ~16 ms after the target. The final spin is
sub-millisecond and never fires early.

**Clock accuracy — bounded, not eliminated.** The HTTP `Date` header has 1-second resolution, so a
single reading can never beat ±500 ms. `refineServerClock()` polls until the header's second
*changes* — a directly measured boundary rather than an estimate — reaching roughly ±80 ms. It
runs at ARM and again at T-90s.

So the honest claim is: **the click is dispatched within about a millisecond of where the
extension believes 08:00:00.000 is, and that belief is good to roughly ±80 ms.** Every run logs
its actual fire error; read that rather than this paragraph.

**Which is exactly why the retry exists.** Because a search sent early returns an empty results
page rather than an error, a click a few milliseconds ahead of the server lands there. The engine
recognises that specific page and re-submits — about ten searches over four seconds, stopping the
instant trains appear. Without it, the ±80 ms clock margin alone would be enough to lose a
booking.

### Removing work from the T0 path

| Change | Why it mattered |
|---|---|
| Search button resolved at ARM, not T0 | A full multi-tier element search at the one moment nothing should be searched for |
| Page scanning frozen from T-1s | `snapshot()` ran `detectPage()` on every state change — three whole-document scans sat in front of the click |
| `textContent` instead of `innerText` in scans | `innerText` is layout-dependent; reading it across thousands of elements forces a reflow each time |
| Cheap text tests before visibility checks | `getBoundingClientRect` ran on every candidate; now only on those that already matched |
| `chrome.storage` writes debounced 250 ms | Several transitions fire back-to-back at T0, each previously issuing a write |

At T0 the remaining work is: confirm the button is unobstructed, dispatch a click. Everything
after that is the server — a single search request, since the results page carries the trains,
classes, coaches and every seat map in one response.

The popup's **Activity log** prints measured stage-to-stage timings for every run. Those numbers
are real; nothing in this README substitutes for them.

---

## Architecture

```
src/
├── selectors/railway-selectors.ts   THE ONLY FILE HOLDING SITE FACTS
├── content/
│   ├── element-finder.ts            id → name → aria → label → semantic → class → text → structure
│   ├── dom-engine.ts                event-driven waits, obstruction checks, real click dispatch
│   ├── form-filler.ts               framework-safe value setting, calendar driving, read-back
│   ├── page-detector.ts             which of the eight pages am I on
│   ├── results-parser.ts            accordion rows → TrainResult[]
│   ├── seat-engine.ts               coach scan, legend-derived seat states, confirmed claiming
│   ├── security-detector.ts         always-on CAPTCHA/OTP watch — detection only
│   └── overlay.ts                   on-page status bar in a closed shadow root
├── automation/
│   ├── state-machine.ts             declared transitions; undeclared ones throw
│   ├── booking-states.ts            per-state timeout / retry / failure policy
│   └── booking-engine.ts            the orchestration
├── storage/storage-manager.ts       versioned chrome.storage.local schema + validation
├── popup/  options/                 UI
└── utils/                           timing, event-driven waits, retry, redacting logger
```

Two rules the codebase holds to:

- **Every site fact lives in `railway-selectors.ts`.** No selector literal appears anywhere else,
  so a site change is a one-file patch — or a runtime override under `selectorOverrides` in
  `chrome.storage.local`, with no rebuild at all.
- **Stop safely rather than guess.** Ambiguous page state, unreadable seat colours, a committed
  date that does not match what was asked for — all halt and hand over. There is no blind click
  and no `sleep()` anywhere in the automation.

Design notes: [`docs/01-architecture.md`](docs/01-architecture.md) (state machine, timing, storage,
failure policy) · [`docs/02-page-analysis.md`](docs/02-page-analysis.md) (what each screenshot
established) · [`docs/00-capture-checklist.md`](docs/00-capture-checklist.md) (what still needs
capturing).

---

## Development

```bash
npm run typecheck
npm test          # 123 tests
npm run build
```

Tests run on happy-dom against fixtures reconstructed from real page text. `tests/safety.test.ts`
is the guardrail suite — log redaction, arming validation, and proof that no code path can commit
a purchase.

---

## Status

Working as a personal tool, with the purchase step deliberately left to a human.

| Gap | Why | Effect |
|---|---|---|
| Passenger page not mapped | DOM never captured | Auto-fill is **off**; the run stops there and asks |
| Payment page not mapped | DOM never captured | Detection relies on action-phrase buttons or leaving the origin. Payment is a hand-over regardless |
| Confirmation page not mapped | DOM never captured | Reference extraction is best-effort; reports failure rather than inventing a value |
| No structural selectors | No page HTML captured | Everything resolves by label, placeholder and text. CSS hints exist but are allowed to miss |
| Station autocomplete unconfirmed | Dropdown never captured open | Handled defensively: type, click an exact suggestion if one appears, verify the committed value |
| No notification icon | No `icon-128.png` | Only affects the optional pre-window reminder |

---

## Use

Written for one person's own Railway account, to buy the number of tickets that account is already
entitled to. It works through the ordinary browser session and the ordinary website interface, and
every security control — CAPTCHA, OTP, payment authentication, account limits — is handed to the
human rather than touched.

If you run it, run it on your own account, and check that automated interaction is compatible with
the site's terms of service where you are. No warranty of any kind.
