# Architecture — Bangladesh Railway QuickBook

Covers First-Task items 3–10. Items 1–2 (page map, selector map) live in
`02-page-analysis.md` and remain partly `UNVERIFIED` pending HTML.

Written against the flow observed in the supplied screenshots, **not** a generic booking flow.

---

## 0. Operating runbook (what you actually do)

| When | Who | What |
|---|---|---|
| Any time before 07:45 | You | Open the extension options. Enter route, date, train priority 1–3, class priority 1–3, and 4 passenger profiles. Saved to `chrome.storage.local`, persists forever. |
| ~07:45 | You | Open Chrome, go to the Railway site, **log in yourself**. The extension never sees credentials. |
| ~07:50 | You | Open the popup, press **ARM**. |
| 07:50–08:00 | Extension | Validates everything, resolves selectors, syncs its clock to the server, **pre-fills the search form**, and waits. Reports `● ARMED` or refuses with the exact reason. |
| 08:00:00 | Extension | Detects opening from site state, submits search, expands preferred train, picks class, opens seat map, claims up to 4 seats, sets boarding station, continues. |
| On CAPTCHA / OTP | Extension | **Stops.** Shows `USER ACTION REQUIRED`. You solve it. Press Continue. |
| On payment | Extension | **Stops.** You pay. |
| After payment | Extension | Detects confirmation, shows booking reference. |

**The extension refuses to arm** if any of: not logged in, a passenger profile incomplete, route
or date unset, page unrecognized. Failing at 07:50 with a clear message is the entire point —
discovering a missing NID at 08:00:00.4 is a lost booking.

---

## 3. State machine

Beyond your required list I have added five states, because seat selection turned out to be real
and is where the booking is actually won or lost. Every added state is marked **[+]**.

Global rules: **STOP** (button or `Esc`) is accepted from every state → `STOPPED`.
No state advances on a timer; each needs its success condition observed.
Ambiguous state → `FAILED`, never a speculative click.

| State | Entry condition | Action | Success condition | Timeout | Retry | On failure |
|---|---|---|---|---|---|---|
| `IDLE` | Load, or after STOP | Listen only | Host match | — | — | — |
| `SITE_DETECTED` | URL matches host pattern `UNVERIFIED` | Probe session marker | Marker found | 5 s | observer-driven | → `IDLE` |
| `SESSION_READY` | User-name element present, not a Login link | Cache marker; re-check every 60 s while armed | Name text non-empty | 3 s | re-probe on mutation | → `USER_ACTION_REQUIRED` ("log in") |
| `BOOKING_PAGE_READY` | From, To, Date, Class, Search all found | Resolve + cache handles | All 5 resolved | 5 s | observer on form container | → `FAILED` (page unrecognized) |
| `PREPARING` | ARM pressed | Validate config; validate 4 profiles; resolve selectors; sync clock; **pre-fill form** | Every check passes | 15 s | none | → `FAILED`, naming the exact missing field |
| `ARMED` | `PREPARING` passed | Hold; heartbeat session check | — | — | — | session lost → `USER_ACTION_REQUIRED` |
| `WAITING_FOR_BOOKING_OPEN` | `ARMED` + T0 computed | Countdown chain + site-state watcher | Open signal (§4) | T0 + 120 s | — | → `FAILED` ("never opened") |
| `BOOKING_OPEN` | Open signal fired | Assert form still populated | Search button enabled | 2 s | re-fill once | → `FAILED` |
| `ROUTE_READY` | From + To committed | Assert committed values | Read-back matches intent | 1 s | re-fill once | → `FAILED` |
| `DATE_READY` | Date committed | Assert committed value | Read-back matches intent | 1 s | re-fill once | → `FAILED` |
| `SEARCHING` | Search clicked | Await results | Results container present | 10 s | 2 | → `FAILED` |
| `RESULTS_READY` | Results present | Parse all train rows | ≥ 1 row parsed | 5 s | 1 re-parse | → `FAILED` |
| `TRAIN_SELECTION` | Rows parsed | Expand highest-priority train | Expanded panel with class cards | 4 s | 2, then next priority | all priorities exhausted → `FAILED` ("no preferred train") |
| `CLASS_SELECTION` | Class cards parsed | Pick by priority ∧ availability ≥ 1 | Seat panel opens | 6 s | next class, then next train | exhausted → `FAILED` ("no availability") |
| **[+]** `SEAT_PANEL_READY` | Panel open | Resolve coach select, grid, boarding select, continue button | All resolved | 4 s | 1 | → `FAILED` |
| **[+]** `COACH_SELECTION` | Panel ready | Read free-seat counts from `<select>` option text; pick per policy (§8.3) | Grid rendered for chosen coach | 3 s | next coach | no coach with free seats → back to `CLASS_SELECTION` |
| **[+]** `SEAT_SELECTING` | Grid rendered | Click one available seat; **confirm via Seat Details table**; repeat | Confirmed count reached target | 3 s per seat | 1 per seat, then mark taken | 0 confirmed → next coach |
| **[+]** `SEATS_CONFIRMED` | ≥ 1 seat confirmed | Validate boarding station is set | Boarding value non-empty | 3 s | 1 | → `USER_ACTION_REQUIRED` |
| **[+]** `PURCHASE_CONTINUE` | Seats + boarding valid | Assert seat count matches intent, then click Continue Purchase | Navigation or next-stage DOM | 8 s | 1 | → `FAILED` |
| `PASSENGER_PAGE` | Passenger form detected | Resolve fields | Fields resolved | 5 s | 1 | → `FAILED` |
| `PASSENGERS_FILLING` | Fields resolved | Fill N profiles, read back each | All read-backs match | 6 s | 1 per field | → `USER_ACTION_REQUIRED` |
| `PASSENGERS_COMPLETE` | All filled | Click continue | Stage advances | 8 s | 1 | → `FAILED` |
| `SECURITY_CHECK` | CAPTCHA/verification markers seen | **Halt all automation**, disconnect observers | — | — | — | → `USER_ACTION_REQUIRED` |
| `USER_ACTION_REQUIRED` | Any halt needing you | Show banner + popup prompt; wait for Continue | You press Continue | none | — | STOP → `STOPPED` |
| `SECURITY_COMPLETE` | You pressed Continue | **Re-detect page from scratch** | Known state identified | 5 s | 1 | ambiguous → `FAILED` |
| `FINAL_REVIEW` | Review stage detected | Parse summary, display it | Summary parsed | 5 s | 1 | → `USER_ACTION_REQUIRED` |
| `PAYMENT_REQUIRED` | Payment stage detected | Stop automation | — | — | — | → `USER_PAYMENT_REQUIRED` |
| `USER_PAYMENT_REQUIRED` | — | Watch **only** for return/confirmation | You complete payment | 15 min | — | → `FAILED` (timed out) |
| `CONFIRMATION` | Confirmation markers seen | Extract reference + details | Reference found | 10 s | 2 | → `FAILED` ("paid but unparsed" — surfaced loudly) |
| `SUCCESS` | Reference extracted | Persist record, notify | terminal | — | — | — |
| `FAILED` | Any unrecoverable | Disconnect observers, clear timers, freeze log | terminal | — | — | — |
| `STOPPED` | STOP / `Esc` | Full teardown | terminal | — | — | — |

`SECURITY_CHECK` and `PAYMENT_REQUIRED` are reachable **from every automated state**, not just
their nominal position. Verification can appear anywhere; the detector runs continuously.

---

## 4. Timing architecture

### 4.1 The service worker cannot own T0
MV3 service workers are evicted after ~30 s idle and `chrome.alarms` granularity is far too coarse
for a sub-second trigger. **The content script owns the countdown**; the alarm is only a coarse
backstop that wakes the worker to check the content script is still alive.

### 4.2 Countdown chain (no long `setTimeout`, no polling loop)
Long timers drift and get throttled. Instead, a self-correcting chain re-derived from
`performance.now()` at each hop:

```
T-∞ … T-60s   one setTimeout, recomputed on fire
T-60s … T-2s  one setTimeout, recomputed on fire
T-2s  … T-50ms  short chained setTimeouts, each recomputing remaining time
T-50ms … T0   requestAnimationFrame gate, fire on first frame where now >= T0
```

Background tabs get throttled — the tab must be **foreground**. The popup will say so.

### 4.3 Clock discipline
Your PC clock is not authoritative and may be seconds off. At ARM, and again at T-60 s, take a
small number of same-origin requests and read the HTTP `Date` response header, keeping the sample
with the **lowest round-trip** (NTP-style) to compute `serverOffsetMs`.

- Resolution of `Date` is 1 second, so this gives roughly ±500 ms — adequate, and honest about it.
- Cost: a handful of requests spread over ten minutes. Negligible load, no hammering.

### 4.4 Bangladesh time without assuming your timezone
T0 is derived via `Intl.DateTimeFormat` with `timeZone: 'Asia/Dhaka'`, so it is correct whether
your laptop is set to Dhaka, UTC, or anything else. BST is UTC+6 with no DST, but this is derived
rather than hard-coded so it cannot silently rot.

### 4.5 Clock is a scheduler, never proof
`08:00:00` decides *when to start watching*. The transition to `BOOKING_OPEN` requires a **site
signal**. Candidate signals, in preference order — all `UNVERIFIED` until you describe pre-08:00
behaviour:

1. Search button transitions disabled → enabled
2. A site countdown element hitting zero / disappearing
3. A "not yet open" notice disappearing
4. Last resort: clock + a single search attempt, with the response classified

Firing early is not free — an error page can cost more time than it saves. Default offset is `0`,
configurable, to be tuned with a dry run.

### 4.6 Instrumentation
`performance.now()` for every internal measurement; wall clock only for scheduling and log display.
Timeline entries recorded to a preallocated ring buffer in memory — **no `chrome.storage` writes
during the critical window** — flushed after the run. Every stage from §3 emits enter/exit marks.

All timings in the final report will be **measured**. None will be invented.

---

## 5. Extension architecture

```
railway-quickbook/
├── manifest.json
├── package.json  tsconfig.json  vite.config.ts
├── src/
│   ├── background/service-worker.ts     alarms backstop, cross-nav state relay, notifications
│   ├── content/
│   │   ├── bootstrap.ts                 document_start entry
│   │   ├── page-detector.ts             which of the 8 pages am I on
│   │   ├── element-finder.ts            8-tier resolution (§ below)
│   │   ├── dom-engine.ts                waitFor* primitives, scoped observers
│   │   ├── form-filler.ts               set value + dispatch framework-correct events + read back
│   │   ├── results-parser.ts            accordion rows → TrainResult[]
│   │   ├── seat-engine.ts               coach scan, seat claim loop, confirmation  ← core
│   │   ├── security-detector.ts         always-on CAPTCHA/OTP watch
│   │   └── confirmation-parser.ts
│   ├── automation/booking-engine.ts  state-machine.ts  booking-states.ts
│   ├── popup/     options/     storage/storage-manager.ts
│   ├── selectors/railway-selectors.ts   THE ONLY FILE HOLDING SITE FACTS
│   ├── utils/logger.ts  timing.ts  retry.ts  wait.ts
│   └── types/index.ts
└── tests/fixtures/                      real HTML you supply, verbatim
```

**Single-source-of-truth rule:** every site fact lives in `railway-selectors.ts`, versioned, and
overridable at runtime from `chrome.storage.local`. When the site changes, you patch selectors in
the options page without a rebuild. No selector literal appears anywhere else.

### Element resolution order
`id → name → aria-label → associated label → data-* → stable class → text → relative structure`.
Each descriptor carries fallbacks; `:nth-child` is barred except as a last-resort escape hatch that
logs a warning when used.

### Messaging contract
Typed discriminated union, one channel, no stringly-typed actions:
`ARM | DISARM | STOP | CONTINUE_AFTER_USER | STATE_CHANGED | LOG_APPEND | TIMELINE_FLUSH`.
Popup is a **pure view** — it holds no state and can be closed at any time without affecting a run.

---

## 6. Permissions

```jsonc
{
  "manifest_version": 3,
  "permissions": ["storage", "alarms"],
  "optional_permissions": ["notifications"],
  "host_permissions": ["<railway origin>/*"]   // UNVERIFIED — awaiting the URL
}
```

- No `<all_urls>`.
- No `tabs` — host permission already exposes the tab URLs we need.
- No `scripting` — content scripts are **declarative** so they run at `document_start`, which is
  both faster and one less permission.
- No `webRequest`, no `declarativeNetRequest`: we do not touch traffic.
- CSP default. No `eval`, no `new Function`, no remote code, no external requests.

---

## 7. Storage model

`chrome.storage.local`, one versioned root with a migration function.

```ts
{
  schemaVersion: 1,
  journey:  { fromStation, toStation, dateISO, classPriority: [c1, c2, c3] },
  trains:   { priority: [t1, t2, t3] },
  seatPolicy: {
    partial: 'TAKE_AVAILABLE_THEN_STOP',   // your choice
    coachSpread: 'PREFER_SINGLE_ALLOW_SPLIT', // your choice
    targetSeats: 4
  },
  passengers: [ /* 4 × { name, age, gender, type, ...UNVERIFIED } */ ],
  selectorOverrides: { /* patch site facts without a rebuild */ },
  runState: { state, stageStartedAt, confirmedSeats, trainIdx, classIdx },  // refresh recovery
  lastResult: { reference, train, date, route, class, passengerCount },
  timeline: [ /* last run only, flushed post-run */ ]
}
```

**Never stored, in any form:** passwords, card numbers, CVV, OTP, CAPTCHA tokens, session cookies.
The logger runs a redaction pass before any write, so a future field cannot leak by accident.

`runState` exists solely so a mid-flow page refresh resumes deliberately rather than restarting
blindly — see §9.

---

## 8. Performance strategy

### 8.1 The real budget
Sequence at T0: submit search → parse results → expand train → click class → open seat map →
**4 sequential seat confirmations** → boarding → continue. Every arrow is a server round-trip.

Extension-controlled cost is DOM work: microseconds to low milliseconds. Server cost: tens to
hundreds of ms each, and unbounded under load. **The extension removes human latency and dead
waiting. It does not make the server faster, and I will not claim otherwise.**

### 8.2 Everything expensive happens before 08:00
By T-30 s: selectors resolved and cached, config validated, clock synced, search form **already
filled**, parsers warm, observers pre-attached to containers that already exist. The action at T0
is one click dispatch.

### 8.3 Seat engine (the contended step)
1. Read every coach's free-seat count **from the `<select>` option text** — no clicks, no renders.
2. Rank: coaches with ≥ 4 free first (your "prefer one coach"), then by descending free count.
3. In the chosen coach, claim seats **one at a time**, each confirmed against the Seat Details
   table before the next. A rejected seat is expected, not an error — mark taken, take the next.
4. Short of 4 in this coach → move to the next-best coach and continue (your "any 4 is better").
5. Total across all coaches under 4 → take what was confirmed and stop for you (your policy).
6. Never fire concurrent seat clicks. Server-hammering, and the hold logic would reject it anyway.

### 8.4 Standing rules
- Observers scoped to specific containers, never `document` + `subtree` — the page's live "active
  users" counters would otherwise fire them continuously (see `02-page-analysis.md` O-3).
- Disconnect on resolve. Every observer has an owner and a teardown.
- No `getComputedStyle` in hot paths; parse text and attributes.
- Read-then-write DOM batching to avoid layout thrash.
- No storage writes, no JSON serialization on the critical path.
- No polling where an event exists. No blind `sleep`, anywhere, ever.
- No concurrent request fan-out. One action in flight at a time.

---

## 9. Failure and recovery

| Situation | Response |
|---|---|
| Element missing | Fallback chain → scoped observer wait → bounded retry → `FAILED`. Never a blind click. |
| DOM replaced | Cached handles validated with `isConnected` before use; stale → re-resolve. |
| Unexpected navigation | Re-run page detection, reconcile against `runState`, resume only if the state is unambiguous. |
| **Page refresh mid-flow** | Read `runState`; re-detect the page; **continue only if detected page and stored state agree**. Disagreement → `USER_ACTION_REQUIRED`, never a blind restart. A blind restart could double-book. |
| Class sold out between parse and click | Expected. Fall to next class, then next train. |
| Seat taken between render and click | Expected. Mark taken, take the next. |
| Session lost | Halt, prompt you to log in, re-verify before resuming. |
| Verification appears | Immediate halt, observers down, prompt you. |
| State ambiguous | **Stop safely.** This outranks every other rule. |

STOP (button or `Esc`) tears down observers, timers, and pending retries, then returns to `IDLE`.

---

## 10. Roadmap

| Phase | Content | Status |
|---|---|---|
| 1 | Page/DOM/state/timing analysis | Partly done — blocked on HTML for the selector map |
| 2 | MV3 foundation, build, messaging, storage, popup shell | **Unblocked** except `host_permissions` |
| 3 | Preparation: session detect, config, validation, ARM, clock sync | Needs the URL + session marker |
| 4a | Search fill + submit + results parser | Needs home + results HTML |
| 4b | Accordion expand, class parse, **seat engine** | Needs results + seat-panel HTML |
| 5 | Security detection, pause/resume, payment checkpoint | Needs pages 6–7 |
| 6 | Confirmation parser | Needs page 8 |
| 7 | Profiling, measured timings | After 4b |
| 8 | Fixture tests from your real HTML | Alongside each phase |

### To unblock the next commit
1. The **URLs** of home, results, and seat pages
2. **Snippet B** on each of those three
3. **Snippet C** on: one collapsed train row, one expanded train row with class cards, the coach
   `<select>` with its options, the seat grid
4. **Network tab**: is `SEARCH TRAINS` a document navigation or an xhr? Same for a class card click
5. What the site shows **before 08:00**
