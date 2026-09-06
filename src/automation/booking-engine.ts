import type { AppConfig, BookingResult, ClassOffer, RunState, TrainResult, ValidationIssue } from '@/types';
import { BOOKING_OPEN as OPEN_HINTS, RESULTS, SEARCH_FORM, SEATS } from '@/selectors/railway-selectors';
import { StateMachine } from './state-machine';
import { STATE_POLICY } from './booking-states';
import { findAll, findOne, isAlive, isEnabled, isVisible, normText } from '@/content/element-finder';
import {
  ensureUnobstructed,
  realClick,
  scrollIntoViewIfNeeded,
  waitForElement,
  waitForEnabled,
} from '@/content/dom-engine';
import { dateValueMatches, fillStationField, pickDate, selectValue } from '@/content/form-filler';
import {
  findNoResultsNotice,
  isBookable,
  matchesTrainPreference,
  parseTrainRows,
} from '@/content/results-parser';
import { claimSeats, readClaimedSeats, resolveSeatPanel } from '@/content/seat-engine';
import { detectPage, detectSession, findNotOpenNotice } from '@/content/page-detector';
import { runPreflight } from '@/content/preflight';
import { detectPayment, detectSecurity } from '@/content/security-detector';
import { hasConfirmationMarker, parseConfirmation } from '@/content/confirmation-parser';
import { clearRunState, loadConfig, saveResult, saveRunState, validateConfig } from '@/storage/storage-manager';
import { logger } from '@/utils/logger';
import { waitFor, waitForQuiet } from '@/utils/wait';
import {
  Stopwatch,
  getServerOffsetConfidenceMs,
  getServerOffsetMs,
  formatBst,
  nextBstOccurrence,
  refineServerClock,
  scheduleAt,
  serverNow,
  syncServerClock,
  type CountdownHandle,
} from '@/utils/timing';
import type { EngineSnapshot } from '@/messaging/protocol';

/** Thrown when automation must stop and hand the page to the user. Not a fault. */
class HaltForUser extends Error {
  constructor(readonly userReason: string) {
    super(userReason);
    this.name = 'HaltForUser';
  }
}

/** Thrown when the run cannot continue safely. */
class SafeStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeStop';
  }
}

export type SnapshotListener = (snapshot: EngineSnapshot) => void;

export class BookingEngine {
  private readonly machine = new StateMachine();
  private readonly stopwatch = new Stopwatch();
  private config: AppConfig | null = null;
  private abort: AbortController | null = null;
  private countdown: CountdownHandle | null = null;
  private targetEpochMs: number | null = null;
  private confirmedSeats: string[] = [];
  private awaitingUserReason: string | null = null;
  private issues: ValidationIssue[] = [];
  private detail = '';
  private readonly siteOrigin = location.origin;
  private readonly listeners = new Set<SnapshotListener>();
  private resumeAfterUser: (() => Promise<void>) | null = null;
  /** Resolved by GO NOW to skip the countdown. Null unless we are waiting. */
  private manualTrigger: (() => void) | null = null;
  /** Resolved at ARM so T0 costs one click, not a fresh multi-tier element search. */
  private searchButton: HTMLElement | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPending: RunState | null = null;
  /** True from pre-arm until hand-over: snapshots stop scanning the page. */
  private hot = false;
  /** The search click happens exactly once per run. */
  private fired = false;
  private cachedPage = 'UNKNOWN';
  private cachedLoggedIn = false;

  constructor() {
    this.machine.onChange((state, reason) => {
      this.detail = reason;
      this.persistRunState({
        state,
        stateEnteredAtPerf: this.stopwatch.elapsed(),
        stateEnteredAtWall: serverNow(),
        trainIdx: 0,
        classIdx: 0,
        confirmedSeats: this.confirmedSeats,
        lastError: null,
        awaitingUserReason: this.awaitingUserReason,
      });
      this.emit();
    });
  }

  /**
   * Persist on a trailing timer rather than on every transition.
   *
   * The booking flow fires several transitions back to back at T0, and each one was issuing a
   * chrome.storage write. Storage is only needed for refresh recovery, which does not care
   * about 250 ms of lag, so the writes are coalesced off the critical path.
   */
  private persistRunState(state: RunState): void {
    this.persistPending = state;
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const pending = this.persistPending;
      this.persistPending = null;
      if (pending) void saveRunState(pending);
    }, 250);
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  onSnapshot(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): EngineSnapshot {
    /**
     * detectSession and detectPage each scan the whole document, and snapshot() runs on every
     * state change. During the critical window that is exactly the work that must not happen,
     * so once pre-armed the last known values are reused instead of re-derived.
     */
    if (!this.hot) {
      this.cachedLoggedIn = detectSession().loggedIn;
      this.cachedPage = detectPage(this.siteOrigin).kind;
    }
    return {
      state: this.machine.state,
      detail: this.detail,
      armed: !['IDLE', 'FAILED', 'STOPPED', 'SUCCESS'].includes(this.machine.state),
      loggedIn: this.cachedLoggedIn,
      page: this.cachedPage,
      targetEpochMs: this.targetEpochMs,
      serverOffsetMs: getServerOffsetMs(),
      serverOffsetConfidenceMs: getServerOffsetConfidenceMs(),
      confirmedSeats: [...this.confirmedSeats],
      targetSeats: this.config?.seatPolicy.targetSeats ?? 4,
      elapsedMs: Number(this.stopwatch.elapsed().toFixed(1)),
      awaitingUserReason: this.awaitingUserReason,
      tabHidden: document.hidden,
      issues: this.issues,
      timeline: logger.timelineReport(),
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* ignored */
      }
    }
  }

  /** Full teardown. Safe to call from any state, including mid-await. */
  stop(reason: string): void {
    this.abort?.abort();
    this.abort = null;
    this.hot = false;
    this.countdown?.cancel();
    this.countdown = null;
    this.resumeAfterUser = null;
    this.awaitingUserReason = null;
    logger.setQuiet(false);
    logger.warn(`STOP: ${reason}`);
    this.machine.force('STOPPED', reason);
    void clearRunState();
    this.emit();
  }

  /** Skip the countdown and run the booking flow immediately. */
  runNow(): void {
    if (!this.manualTrigger) {
      logger.warn(`GO NOW ignored - not waiting for the booking window (state: ${this.machine.state})`);
      return;
    }
    logger.info('GO NOW pressed - skipping the countdown');
    this.manualTrigger();
  }

  disarm(): void {
    this.countdown?.cancel();
    this.countdown = null;
    this.abort?.abort();
    this.abort = null;
    this.targetEpochMs = null;
    this.machine.force('IDLE', 'disarmed');
    void clearRunState();
    this.emit();
  }

  /** Called when the user says they have finished a CAPTCHA / OTP / payment step. */
  async continueAfterUser(): Promise<void> {
    if (!this.machine.isWaitingOnHuman) {
      logger.warn('Continue pressed but automation was not waiting on you');
      return;
    }

    // Re-detect from scratch. Nothing is assumed about where we ended up.
    const still = detectSecurity();
    if (still) {
      logger.warn(`Verification still on screen (${still.evidence}) - not resuming`);
      this.detail = 'Verification still visible';
      this.emit();
      return;
    }

    this.awaitingUserReason = null;
    this.machine.transition('SECURITY_COMPLETE', 'user completed the step');

    const page = detectPage(this.siteOrigin);
    logger.info(`Resuming: page detected as ${page.kind} (${page.evidence})`);

    if (!page.confident) {
      this.fail(`Page state is ambiguous after your step (${page.evidence}). Stopping rather than guessing.`);
      return;
    }

    const resume = this.resumeAfterUser;
    this.resumeAfterUser = null;

    try {
      if (resume) {
        await resume();
      } else {
        await this.continueFromPage();
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  // -------------------------------------------------------------------------
  // ARM
  // -------------------------------------------------------------------------

  /** Bail out of the current step if STOP was pressed while we were awaiting something. */
  private assertRunning(signal: AbortSignal): void {
    if (signal.aborted) throw new SafeStop('stopped');
  }

  async arm(): Promise<void> {
    try {
      this.abort?.abort();
      const controller = new AbortController();
      this.abort = controller;
      this.hot = false;
      this.fired = false;
      this.confirmedSeats = [];
      this.issues = [];
      logger.clear();
      this.machine.reset();
      this.stopwatch.reset();

      this.config = await loadConfig();

      // 1. Site
      this.machine.transition('SITE_DETECTED', location.host);
      logger.info(`Site detected: ${location.host}`);

      // 2. Session - never handles credentials, only observes that one exists.
      const session = detectSession();
      if (!session.loggedIn) {
        this.requireUser('You are not logged in. Log in to the Railway site, then press ARM again.');
        return;
      }
      this.machine.transition('SESSION_READY', 'user menu present');
      logger.info('Session verified (logged in)');

      // 3. Booking page
      const page = detectPage(this.siteOrigin);
      if (page.kind !== 'HOME') {
        this.fail(`Open the Railway home/search page before arming. Detected: ${page.kind} (${page.evidence}).`);
        return;
      }
      this.machine.transition('BOOKING_PAGE_READY', 'search form resolved');

      // 4. Prepare
      this.machine.transition('PREPARING', 'validating and pre-filling');
      await this.prepare(controller.signal);

      // Preparation is a long sequence of awaits. If STOP landed during any of them, this run
      // is over - continuing would drive the form while the machine sits in STOPPED.
      this.assertRunning(controller.signal);

      // 5. Armed
      this.machine.transition('ARMED', 'ready and waiting');
      logger.info('ARMED - everything prepared before the booking window');

      // 6. Wait
      this.machine.transition('WAITING_FOR_BOOKING_OPEN', 'countdown started');
      await this.waitForBookingOpen();
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Everything expensive happens here, before the window opens: validation, clock sync,
   * selector resolution, and the actual form fill. At T0 the only remaining work is a
   * single click.
   */
  private async prepare(signal: AbortSignal): Promise<void> {
    const config = this.config!;

    this.issues = validateConfig(config);
    if (this.issues.length > 0) {
      const summary = this.issues.map((i) => `${i.field}: ${i.message}`).join(' | ');
      this.fail(`Cannot arm - fix these first: ${summary}`);
      throw new SafeStop('validation failed');
    }
    logger.info(`Config validated - ${config.seatPolicy.targetSeats} seat(s), ${config.passengers.length} profiles`);

    /**
     * Pre-flight against the live site.
     *
     * validateConfig only proves the fields are filled in. This proves they match something the
     * site actually serves - the check that would have saved the run lost to
     * "BANALATA EXPRESS (792)" on a route that lists (791).
     */
    const preflight = await runPreflight(config, this.siteOrigin, signal);
    this.assertRunning(signal);

    for (const issue of preflight.issues) logger.warn(`Pre-flight: ${issue.message}`);
    if (preflight.issues.length > 0) {
      this.issues = [...this.issues, ...preflight.issues];
      this.emit();
    }

    if (preflight.routeBroken) {
      const detail = preflight.issues.map((i) => i.message).join(' ');
      this.fail(`Pre-flight failed. ${detail}`);
      throw new SafeStop('preflight: route not verifiable');
    }

    // Fatal only when NOTHING usable remains. One unmatched alternative may simply not run on
    // the probed day; zero matches means 08:00 would certainly fail.
    if (preflight.labelsSeen.length > 0 && preflight.matched.length === 0) {
      this.fail(
        `None of your preferred trains run on this route. ` +
          `The site lists: ${preflight.labelsSeen.join(', ')}. Fix the train names and re-arm.`
      );
      throw new SafeStop('preflight: no preferred train on route');
    }

    if (preflight.matched.length > 0) {
      logger.info(
        `Pre-flight OK - ${preflight.matched.join(', ')} present on ${preflight.probedDateIso}`
      );
    }

    // Clock sync: a coarse offset, then a refinement that pins the server's second boundary.
    // Both happen here, long before the window; neither is repeated inside it.
    await syncServerClock(location.origin + location.pathname, 5);
    await refineServerClock(location.origin + location.pathname);
    logger.info(
      `Clock synced: offset ${getServerOffsetMs()}ms (±${getServerOffsetConfidenceMs()}ms). ` +
        `Server time now ${formatBst(serverNow())} BST`
    );

    const skew = Math.abs(getServerOffsetMs());
    if (skew > 60_000) {
      logger.warn(
        `Your PC clock is ${(skew / 60_000).toFixed(1)} minutes off the server. The countdown ` +
          'compensates for this, but fix the machine clock anyway (Windows: Settings > Time & ' +
          'language > Sync now) - anything else relying on it is wrong too.'
      );
    }

    // Resolve the form once and pre-fill it.
    const from = (await waitForElement(SEARCH_FORM.fromStation, { timeoutMs: 5000, what: 'origin field' })) as HTMLInputElement;
    const to = (await waitForElement(SEARCH_FORM.toStation, { timeoutMs: 5000, what: 'destination field' })) as HTMLInputElement;
    const date = (await waitForElement(SEARCH_FORM.journeyDate, { timeoutMs: 5000, what: 'date field' })) as HTMLInputElement;

    this.assertRunning(signal);
    const fromResult = await fillStationField(from, config.journey.fromStation);
    if (!fromResult.ok) throw new SafeStop(`Origin not accepted: ${fromResult.note}`);
    logger.info(`Origin set: ${fromResult.committed}`);

    this.assertRunning(signal);
    const toResult = await fillStationField(to, config.journey.toStation);
    if (!toResult.ok) throw new SafeStop(`Destination not accepted: ${toResult.note}`);
    logger.info(`Destination set: ${toResult.committed}`);

    this.assertRunning(signal);
    const dateResult = await pickDate(date, config.journey.dateISO, { signal });
    if (!dateResult.ok) throw new SafeStop(`Date not accepted: ${dateResult.note}`);
    logger.info(`Date set: ${dateResult.committed}`);

    this.assertRunning(signal);

    const wantedClass = config.journey.searchClass || config.preferences.classPriority[0] || '';
    if (wantedClass) {
      const classControl = findOne(SEARCH_FORM.travelClass);
      if (!classControl) throw new SafeStop('Class dropdown not found on the search page');

      // Tapped open first, then driven. SEARCH TRAINS stays disabled until the form validates,
      // so an unset class would leave us armed but unable to submit at T0.
      const classResult = await selectValue(classControl, wantedClass, { signal: this.abort?.signal });
      if (!classResult.ok) throw new SafeStop(`Class not accepted: ${classResult.note}`);
      logger.info(`Search class set: ${classResult.committed}`);
    }

    this.assertRunning(signal);

    // Resolve the submit control NOW and keep the handle. Finding it again at T0 would mean a
    // fresh multi-tier search at the one moment where nothing should be searched for.
    // We do NOT require it to be enabled yet - that transition may itself be the open signal.
    const search = findOne(SEARCH_FORM.searchButton);
    if (!search) throw new SafeStop('SEARCH TRAINS button not found on this page');
    this.searchButton = search;
    logger.info(`Search button ready (currently ${isEnabled(search) ? 'enabled' : 'disabled'})`);
  }

  // -------------------------------------------------------------------------
  // Booking-open detection
  // -------------------------------------------------------------------------

  /**
   * The clock schedules; the site decides.
   *
   * We race three signals and take whichever arrives first: the submit button enabling, a
   * "not open yet" notice disappearing, or - only if the user allows it - the clock alone.
   */
  private async waitForBookingOpen(): Promise<void> {
    const config = this.config!;
    const signal = this.abort!.signal;

    this.targetEpochMs =
      nextBstOccurrence(config.schedule.openTimeBST, serverNow()) + config.schedule.offsetMs;

    logger.info(
      `Booking window target: ${formatBst(this.targetEpochMs)} BST ` +
        `(in ${((this.targetEpochMs - serverNow()) / 1000).toFixed(1)}s)`
    );
    if (document.hidden) {
      logger.warn('This tab is in the background - Chrome throttles timers there. Keep it focused.');
    }
    this.emit();

    /**
     * Re-sync shortly before the window.
     *
     * Scheduling never uses the machine clock as a source of truth - it uses serverNow(), which
     * is Date.now() plus the measured server offset. But that offset was measured at ARM, which
     * may be many minutes earlier, and a drifting machine clock widens the error in between.
     * One more sample set at T-90s keeps the estimate fresh.
     *
     * The target epoch itself is NOT recomputed here: it is an absolute instant, and a better
     * clock estimate does not move it. Recomputing risks rolling it to tomorrow if the improved
     * reading happens to land past the opening time.
     */
    const untilTarget = this.targetEpochMs - serverNow();
    if (untilTarget > 150_000) {
      const resyncTimer = setTimeout(() => {
        void refineServerClock(location.origin + location.pathname).then(() => {
          logger.info(
            `Clock re-synced near the window: offset ${getServerOffsetMs()}ms ` +
              `(±${getServerOffsetConfidenceMs()}ms), server time ${formatBst(serverNow())} BST`
          );
          this.emit();
        });
      }, untilTarget - 90_000);
      signal.addEventListener('abort', () => clearTimeout(resyncTimer), { once: true });
    }

    const searchButton = isAlive(this.searchButton)
      ? this.searchButton
      : findOne(SEARCH_FORM.searchButton);
    const notice = findNotOpenNotice(OPEN_HINTS.notOpenTextHints);

    let resolveOpen!: (reason: string) => void;
    const opened = new Promise<string>((resolve) => {
      resolveOpen = resolve;
    });

    /**
     * Every path to "go" funnels through here, and the click is dispatched SYNCHRONOUSLY inside
     * it - before the promise resolves, before any state transition, before any await. An await
     * between the trigger and the click would hand control back to the event loop at the one
     * moment that must not happen.
     */
    const trigger = (reason: string): void => {
      if (this.fired) return;
      this.fireSearchNow(reason);
      resolveOpen(reason);
    };

    if (searchButton && !isEnabled(searchButton)) {
      void waitForEnabled(searchButton, {
        timeoutMs: config.schedule.maxWaitAfterT0Ms + 3_600_000,
        scope: searchButton.parentElement ?? document.body,
        signal,
        what: 'search button enabled',
      })
        .then(() => trigger('search button became enabled'))
        .catch(() => undefined);
    }

    if (notice) {
      void waitFor(() => (!notice.isConnected || !isVisible(notice) ? 'ok' : null), {
        what: 'not-open notice removed',
        timeoutMs: config.schedule.maxWaitAfterT0Ms + 3_600_000,
        scope: notice.parentElement ?? document.body,
        signal,
      })
        .then(() => trigger('site notice cleared'))
        .catch(() => undefined);
    }

    // Clock signal.
    this.countdown = scheduleAt(this.targetEpochMs, () => {
      if (config.schedule.allowClockFallback) trigger('scheduled time reached');
    });

    // Manual override: GO NOW. Useful for a dry run, and for the case where booking is already
    // open and there is nothing to wait for.
    this.manualTrigger = () => trigger('GO NOW pressed');

    /**
     * Pre-arm one second out.
     *
     * Everything the click needs - a live handle, the element scrolled into view, nothing
     * covering it - is settled here, so T0 costs one event dispatch and nothing else. This also
     * flips the hot flag, which stops snapshots from scanning the page.
     */
    const preArmDelay = this.targetEpochMs - serverNow() - 1_000;
    if (preArmDelay > 0) {
      const preArmTimer = setTimeout(() => void this.preArmFire(), preArmDelay);
      signal.addEventListener('abort', () => clearTimeout(preArmTimer), { once: true });
    } else {
      void this.preArmFire();
    }

    // Watchdog: if nothing ever triggers, fail rather than wait forever.
    const watchdog = setTimeout(
      () => {
        if (!this.fired) {
          this.fail('The booking window never opened and no signal was seen. Nothing was clicked.');
        }
      },
      Math.max(0, this.targetEpochMs - serverNow()) + config.schedule.maxWaitAfterT0Ms
    );

    const abortRace = new Promise<string>((_, reject) => {
      signal.addEventListener('abort', () => reject(new SafeStop('stopped')), { once: true });
    });

    const reason = await Promise.race([opened, abortRace]);

    clearTimeout(watchdog);
    this.countdown?.cancel();
    this.countdown = null;
    this.manualTrigger = null;

    logger.info(`BOOKING OPEN - trigger: ${reason}`);
    this.machine.transition('BOOKING_OPEN', reason);
    await this.runBookingFlow();
  }

  /**
   * Settle everything the click depends on, ahead of time.
   *
   * Runs about a second before the target, so nothing here competes with the dispatch itself.
   */
  private async preArmFire(): Promise<void> {
    const button = isAlive(this.searchButton)
      ? this.searchButton
      : findOne(SEARCH_FORM.searchButton);

    if (!button) {
      logger.error('Search button missing during pre-arm - the page may have changed');
      return;
    }
    this.searchButton = button;

    scrollIntoViewIfNeeded(button);
    const blocker = await ensureUnobstructed(button);
    if (blocker) {
      logger.warn(
        `Search button is covered by <${blocker.tagName.toLowerCase()}> - clicking anyway, but this may miss`
      );
    }

    this.hot = true;
    logger.info(
      `Pre-armed at T-1s: button ${isEnabled(button) ? 'enabled' : 'disabled'}, page scanning paused`
    );
  }

  /**
   * The moment itself. Synchronous, allocation-free, and guarded so it happens exactly once.
   */
  private fireSearchNow(reason: string): void {
    if (this.fired) return;
    this.fired = true;
    this.hot = true;

    let button = this.searchButton;
    if (!isAlive(button)) {
      logger.warn('Cached search button was stale at T0 - re-resolving');
      button = findOne(SEARCH_FORM.searchButton);
    }
    if (!button) {
      logger.error('SEARCH TRAINS button not found at T0 - nothing was clicked');
      return;
    }

    const firedAt = serverNow();
    realClick(button);

    const error = this.targetEpochMs === null ? 0 : firedAt - this.targetEpochMs;
    logger.timing(`SEARCH fired (${reason})`, 'WAITING_FOR_BOOKING_OPEN');
    logger.info(
      `Fired at ${formatBst(firedAt)} BST - ${error >= 0 ? '+' : ''}${error} ms from target ` +
        `(clock accurate to ±${getServerOffsetConfidenceMs()} ms)`
    );
  }

  // -------------------------------------------------------------------------
  // The booking flow
  // -------------------------------------------------------------------------

  /** Runs before every stage: honours STOP, and hands over the moment a challenge appears. */
  private checkpoint(): void {
    if (this.abort?.signal.aborted) throw new SafeStop('stopped');

    const security = detectSecurity();
    if (security) {
      this.machine.transition('SECURITY_CHECK', security.evidence);
      throw new HaltForUser(
        `Security verification required (${security.kind}). Complete it yourself, then press CONTINUE.`
      );
    }
  }

  private async runBookingFlow(): Promise<void> {
    try {
      const config = this.config!;

      /**
       * The search click has already happened - it was dispatched synchronously by
       * fireSearchNow() at the trigger, with nothing between. What follows is bookkeeping and
       * the wait for results; none of it was allowed to sit in front of the click.
       */
      this.machine.transition('ROUTE_READY', 'verified during preparation');
      this.machine.transition('DATE_READY', 'verified during preparation');
      this.machine.transition('SEARCHING', 'search submitted');

      const trains = await this.awaitResultsWithRetry();
      if (!trains) return; // already reported as a failure or handed to the user

      this.machine.transition('RESULTS_READY', `${trains.length} trains`);
      logger.info(`Results: ${trains.map((t) => t.rawLabel).join(', ')}`);

      // Now that results are in, check for a challenge. Doing this before the click would have
      // put a full-document scan directly in front of the dispatch.
      this.checkpoint();

      await this.selectTrainAndClass();
    } catch (error) {
      this.handleError(error);
    }
  }

  /**
   * Wait for results, re-submitting while the site reports "No train found".
   *
   * The SEARCH TRAINS button is enabled at all times, so a search issued before the date is
   * released does not fail - it returns the empty-results page. Since the clock is only good to
   * roughly +/- 80 ms and the server may take a moment to publish the day, a click at
   * 08:00:00.000 can legitimately land there. Retrying is the difference between booking and
   * staring at "Please try different dates or cities".
   *
   * Bounded on purpose: ~10 searches over ~4 seconds. That is a handful of ordinary searches,
   * not a refresh loop.
   */
  private async awaitResultsWithRetry(): Promise<TrainResult[] | null> {
    const config = this.config!;
    const target = config.seatPolicy.targetSeats;
    const maxAttempts = Math.max(1, config.schedule.maxEmptyRetries + 1);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await waitFor(
        () => {
          const parsed = parseTrainRows(target);
          if (parsed.length > 0) return { kind: 'trains' as const, trains: parsed };
          const empty = findNoResultsNotice();
          return empty ? { kind: 'empty' as const, phrase: empty } : null;
        },
        {
          what: 'search results',
          timeoutMs: STATE_POLICY.SEARCHING?.timeoutMs ?? 12_000,
          scope: document.body,
          signal: this.abort?.signal,
        }
      ).catch(() => null);

      if (outcome?.kind === 'trains') {
        if (attempt > 1) {
          logger.info(`Trains appeared on attempt ${attempt} of ${maxAttempts}`);
        }
        return outcome.trains;
      }

      if (!outcome) {
        this.fail('Neither results nor an empty-results message appeared after the search.');
        return null;
      }

      logger.warn(`Attempt ${attempt}/${maxAttempts}: site reports "${outcome.phrase}"`);

      if (attempt === maxAttempts) {
        this.requireUser(
          `The site still reports "${outcome.phrase}" after ${maxAttempts} searches. Either the ` +
            'date has not been released yet, or this route has no trains that day. Nothing was ' +
            'booked - check the page, then press CONTINUE or STOP.'
        );
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, config.schedule.emptyRetryGapMs));
      if (this.abort?.signal.aborted) return null;

      if (!(await this.resubmitSearch())) {
        this.requireUser(
          'Could not re-submit the search automatically. Press SEARCH TRAINS yourself, then press CONTINUE.'
        );
        return null;
      }
    }
    return null;
  }

  /** Re-run the same search, whichever way this page allows. */
  private async resubmitSearch(): Promise<boolean> {
    // 1. The search control is still on the page - an in-place search.
    if (isAlive(this.searchButton) && isVisible(this.searchButton)) {
      realClick(this.searchButton);
      return true;
    }

    // 2. We are on the results page: return to the form, confirm it is still filled, submit.
    const modify = findOne(RESULTS.modifySearch);
    if (!modify) return false;
    realClick(modify);

    const search = await waitFor(() => findOne(SEARCH_FORM.searchButton), {
      what: 'search form after MODIFY SEARCH',
      timeoutMs: 3_000,
      scope: document.body,
      signal: this.abort?.signal,
      pollMs: 50,
    }).catch(() => null);

    if (!search) return false;

    await this.ensureFormFilled();
    this.searchButton = search;
    realClick(search);
    return true;
  }

  /** Re-fill only the fields the site did not preserve. */
  private async ensureFormFilled(): Promise<void> {
    const config = this.config!;

    const from = findOne(SEARCH_FORM.fromStation) as HTMLInputElement | null;
    if (from && !normText(from.value).includes(normText(config.journey.fromStation))) {
      await fillStationField(from, config.journey.fromStation);
    }

    const to = findOne(SEARCH_FORM.toStation) as HTMLInputElement | null;
    if (to && !normText(to.value).includes(normText(config.journey.toStation))) {
      await fillStationField(to, config.journey.toStation);
    }

    const date = findOne(SEARCH_FORM.journeyDate) as HTMLInputElement | null;
    if (date && !dateValueMatches(date.value, config.journey.dateISO)) {
      await pickDate(date, config.journey.dateISO, { signal: this.abort?.signal });
    }

    const wanted = config.journey.searchClass || config.preferences.classPriority[0] || '';
    const control = findOne(SEARCH_FORM.travelClass);
    if (wanted && control) {
      const current =
        control instanceof HTMLSelectElement ? normText(control.value) : normText(control.textContent);
      if (!current.includes(normText(wanted))) {
        await selectValue(control, wanted, { signal: this.abort?.signal });
      }
    }
  }

  /**
   * Walk the train priority list, then the class priority list inside each train.
   *
   * Rows are an accordion: class cards do not exist until the row is expanded, so each
   * candidate costs one expand + render before its availability can even be read.
   */
  private async selectTrainAndClass(): Promise<void> {
    const config = this.config!;
    const target = config.seatPolicy.targetSeats;
    const trainPrefs = config.preferences.trainPriority.map((t) => t.trim()).filter(Boolean);

    // Every train label we ever saw, for the failure message. Without this, "not found" gives
    // the user nothing to correct.
    const seen = new Set<string>();

    for (const [trainIdx, preference] of trainPrefs.entries()) {
      this.checkpoint();

      /**
       * WAIT for the train, do not judge the first paint.
       *
       * The results list renders progressively. The previous version parsed once, the instant
       * any row appeared, and declared the preferred train missing if it had not rendered yet -
       * which is exactly how a train that WAS on the page got skipped. The first preference gets
       * the longer window because that is when the list is still filling in.
       */
      const train = await this.awaitTrain(preference, trainIdx === 0 ? 5_000 : 1_200, target, seen);

      if (!train) {
        logger.warn(
          `Priority ${trainIdx + 1} "${preference}" did not appear. Seen so far: ` +
            `${[...seen].join(', ') || 'nothing'}`
        );
        continue;
      }

      this.machine.transition('TRAIN_SELECTION', train.rawLabel);
      logger.info(`Preferred train found: ${train.rawLabel}`);

      const expanded = await this.expandTrain(train, target);
      if (!expanded) {
        logger.warn(`Could not expand ${train.rawLabel}`);
        continue;
      }

      // Class cards render progressively as well. Let the row settle before judging it, for
      // the same reason the train list is waited on rather than sampled once.
      await waitForQuiet(expanded.element, 120, {
        what: 'class cards settled',
        timeoutMs: 1_200,
        signal: this.abort?.signal,
      }).catch(() => undefined);

      const settled =
        parseTrainRows(target).find((t) => t.rawLabel === train.rawLabel) ?? expanded;

      const offer = this.pickClass(settled);
      if (!offer) {
        const summary = settled.classes
          .map((c) => `${c.className}:${c.seatsLeft ?? '?'}${c.hasBookNow ? '' : ' (no BOOK NOW)'}`)
          .join(', ');
        logger.warn(`No bookable preferred class on ${train.rawLabel} - saw ${summary || 'no cards'}`);
        continue;
      }

      this.machine.transition('CLASS_SELECTION', `${offer.className} (${offer.seatsLeft ?? '?'} left)`);
      logger.info(`Class chosen: ${offer.className}, ${offer.seatsLeft ?? 'unknown'} tickets shown`);

      const opened = await this.openSeatPanel(offer);
      if (!opened) {
        logger.warn(`BOOK NOW on ${offer.className} did not open the seat panel - trying next option`);
        continue;
      }

      await this.runSeatStage();
      return;
    }

    this.fail(
      `None of your preferred trains had a bookable preferred class. ` +
        `Wanted in order: ${trainPrefs.join(' > ') || '(none configured)'}. ` +
        `Actually on the page: ${[...seen].join(', ') || 'nothing'}.`
    );
  }

  /**
   * Wait for a specific train to show up in the results.
   *
   * Records every label seen along the way, so a miss can be explained rather than just
   * reported. Strict priority is preserved: this is only ever called for one preference at a
   * time, in the configured order, and never substitutes a different train.
   */
  private async awaitTrain(
    preference: string,
    timeoutMs: number,
    target: number,
    seen: Set<string>
  ): Promise<TrainResult | null> {
    const found = await waitFor(
      () => {
        const trains = parseTrainRows(target);
        for (const train of trains) seen.add(train.rawLabel);
        return trains.find((t) => matchesTrainPreference(t, preference)) ?? null;
      },
      {
        what: `train "${preference}"`,
        timeoutMs,
        scope: document.body,
        signal: this.abort?.signal,
        pollMs: 80,
      }
    ).catch(() => null);

    return found;
  }

  /** Expand an accordion row and wait for its class cards to render. */
  private async expandTrain(train: TrainResult, target: number): Promise<TrainResult | null> {
    if (train.expanded) return train;

    realClick(train.headerElement);

    return waitFor(
      () => {
        const refreshed = parseTrainRows(target).find((t) => t.rawLabel === train.rawLabel);
        return refreshed && refreshed.classes.length > 0 ? refreshed : null;
      },
      {
        what: `${train.rawLabel} expanded`,
        timeoutMs: STATE_POLICY.TRAIN_SELECTION?.timeoutMs ?? 4000,
        // Scoped to the row, never the document: the page's live "users are trying to book"
        // counters would otherwise fire this observer continuously.
        scope: train.element,
        signal: this.abort?.signal,
      }
    ).catch(() => null);
  }

  /** First class in the user's priority order that the site says is actually bookable. */
  private pickClass(train: TrainResult): ClassOffer | null {
    const prefs = this.config!.preferences.classPriority;

    for (const preference of prefs) {
      const offer = train.classes.find((c) => normText(c.className) === normText(preference));
      if (!offer) continue;
      if (!isBookable(offer)) {
        logger.info(`${offer.className}: ${offer.availability}${offer.hasBookNow ? '' : ', no BOOK NOW'} - skipping`);
        continue;
      }
      if (offer.availability === 'UNKNOWN') {
        logger.warn(`${offer.className}: BOOK NOW present but the ticket count was unreadable`);
      }
      return offer;
    }
    return null;
  }

  private async openSeatPanel(offer: ClassOffer): Promise<boolean> {
    const button = offer.bookNowElement ?? findAll(RESULTS.bookNow, { root: offer.element })[0];
    if (!button) return false;

    logger.timing('book now click', 'CLASS_SELECTION');
    realClick(button);

    const panel = await waitFor(() => resolveSeatPanel(), {
      what: 'seat panel',
      timeoutMs: STATE_POLICY.CLASS_SELECTION?.timeoutMs ?? 8000,
      scope: document.body,
      signal: this.abort?.signal,
    }).catch(() => null);

    if (!panel) return false;
    this.machine.transition('SEAT_PANEL_READY', 'coach picker and grid resolved');
    return true;
  }

  /** The contended stage. */
  private async runSeatStage(): Promise<void> {
    const config = this.config!;
    this.checkpoint();

    const handles = resolveSeatPanel();
    if (!handles) throw new SafeStop('Seat panel disappeared');

    this.machine.transition('COACH_SELECTION', 'scanning coaches');
    logger.timing('seat stage start', 'COACH_SELECTION');

    this.machine.transition('SEAT_SELECTING', 'claiming seats');

    const outcome = await claimSeats({
      panel: handles.panel,
      coachSelect: handles.coachSelect,
      detailsPanel: handles.detailsPanel,
      targetSeats: config.seatPolicy.targetSeats,
      policy: config.seatPolicy.coachSpread,
      preferredCoach: config.seatPolicy.preferredCoach,
      signal: this.abort?.signal,
      onSeatConfirmed: (label, count) => {
        // Progress only - the authoritative list comes back in the outcome.
        if (!this.confirmedSeats.includes(label)) this.confirmedSeats.push(label);
        logger.timing(`seat ${count} confirmed`, 'SEAT_SELECTING');
        this.emit();
      },
    });

    this.confirmedSeats = [...outcome.confirmed];
    this.emit();

    logger.info(
      `Seats: ${outcome.confirmed.length}/${config.seatPolicy.targetSeats} confirmed ` +
        `(${outcome.attempted} attempted, coaches ${outcome.coachesTried.join(',') || 'n/a'}, ` +
        `stop reason ${outcome.stopReason})`
    );

    if (outcome.stopReason === 'UNCLASSIFIABLE') {
      this.requireUser(
        'Could not tell free seats from taken ones on this seat map. Stopped instead of clicking blindly - please select the seats yourself.'
      );
      return;
    }

    if (outcome.confirmed.length === 0) {
      this.fail('No seats could be claimed - every seat was taken before the click landed.');
      return;
    }

    /**
     * AUTOMATION ENDS HERE. CONTINUE PURCHASE is never clicked.
     *
     * This is a deliberate hard stop, not a setting, and not conditional on how many seats were
     * secured. Committing the purchase is the user's action by explicit instruction. An earlier
     * version clicked it when short of the target and carried a single seat into the purchase
     * flow; there is now no code path that presses that button.
     */
    this.machine.transition('SEATS_CONFIRMED', outcome.confirmed.join(', ') || 'none');

    // Read back from the site so the count reported is the site's, not our own bookkeeping.
    const heldNow = handles.detailsPanel
      ? readClaimedSeats(handles.detailsPanel)
      : outcome.confirmed;

    // Boarding station is required on this panel - surface it now rather than let it surprise
    // the user at the moment they click purchase.
    const boarding =
      handles.boardingSelect ?? (findOne(SEATS.boardingStation) as HTMLSelectElement | null);
    const boardingNote =
      boarding && !boarding.value ? ' Boarding station is not set - choose it first.' : '';

    logger.timing('seats ready for manual purchase', 'SEATS_CONFIRMED');
    logger.info(`Handing over: site lists ${heldNow.join(', ') || 'no seats'}`);

    this.requireUser(
      heldNow.length >= config.seatPolicy.targetSeats
        ? `${heldNow.length} seat(s) selected: ${heldNow.join(', ')}. ` +
            `Press CONTINUE PURCHASE yourself when you are ready.${boardingNote}`
        : `Only ${heldNow.length} of ${config.seatPolicy.targetSeats} seat(s) secured: ` +
            `${heldNow.join(', ') || 'none'}. Nothing has been purchased. Add more seats yourself, ` +
            `or press STOP to abandon.${boardingNote}`
    );
  }

  /**
   * After the seat stage the flow leaves verified ground: no passenger, payment or
   * confirmation DOM has been supplied. Rather than guess at those pages, the engine
   * identifies what it can and hands over cleanly for the rest.
   */
  private async continueFromPage(): Promise<void> {
    const page = await waitFor(
      () => {
        const detected = detectPage(this.siteOrigin);
        return detected.kind !== 'SEAT' && detected.confident ? detected : null;
      },
      {
        what: 'next stage',
        timeoutMs: 15_000,
        scope: document.body,
        signal: this.abort?.signal,
        pollMs: 150,
      }
    ).catch(() => null);

    if (!page) {
      this.requireUser('The next page did not appear as expected. Check the tab and continue manually.');
      return;
    }

    logger.info(`Next stage: ${page.kind} (${page.evidence})`);

    switch (page.kind) {
      case 'SECURITY': {
        this.machine.transition('SECURITY_CHECK', page.evidence);
        this.requireUser('Security verification required. Complete it yourself, then press CONTINUE.');
        return;
      }
      case 'PAYMENT': {
        this.machine.transition('PAYMENT_REQUIRED', page.evidence);
        this.machine.transition('USER_PAYMENT_REQUIRED', 'handing over');
        this.awaitingUserReason =
          'Payment stage. Complete payment yourself - the extension never handles card details or OTP.';
        logger.info('PAYMENT STAGE - automation stopped, payment is yours');
        this.watchForConfirmation();
        this.emit();
        return;
      }
      case 'CONFIRMATION': {
        await this.captureConfirmation();
        return;
      }
      default: {
        this.machine.transition('PASSENGER_PAGE', page.evidence);
        this.requireUser(
          this.config?.enablePassengerAutofill
            ? 'Passenger page reached, but its field layout has not been verified for this site yet. Fill it in and press CONTINUE.'
            : 'Passenger page reached. Passenger auto-fill is off until this page has been mapped - fill it in and press CONTINUE.'
        );
        return;
      }
    }
  }

  /** During payment we watch only for the confirmation page. Nothing else is touched. */
  private watchForConfirmation(): void {
    void waitFor(() => hasConfirmationMarker(), {
      what: 'booking confirmation',
      timeoutMs: STATE_POLICY.USER_PAYMENT_REQUIRED?.timeoutMs ?? 900_000,
      scope: document.body,
      signal: this.abort?.signal,
      pollMs: 500,
    })
      .then(() => this.captureConfirmation())
      .catch(() => undefined);
  }

  private async captureConfirmation(): Promise<void> {
    this.hot = false;
    this.machine.transition('CONFIRMATION', 'confirmation markers found');

    const result: BookingResult = parseConfirmation(this.confirmedSeats.length, this.confirmedSeats);
    const config = this.config;
    result.route = config ? `${config.journey.fromStation} - ${config.journey.toStation}` : null;
    result.date = config?.journey.dateISO ?? null;

    await saveResult(result);

    if (!result.reference) {
      // A booking that succeeded but whose reference we could not read is reported as
      // exactly that. Inventing a value here would be far worse than admitting the gap.
      logger.warn('Booking confirmed, but the reference could not be parsed from this page.');
    }

    this.machine.transition('SUCCESS', result.reference ?? 'reference not parsed');
    logger.info(`BOOKING SUCCESSFUL - reference ${result.reference ?? '(not parsed)'}`);
    logger.info(`Measured timeline:\n${JSON.stringify(logger.timelineReport(), null, 2)}`);
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  private requireUser(reason: string): void {
    // Handing over: resume full page scanning so the popup shows live state again.
    this.hot = false;
    this.awaitingUserReason = reason;
    if (this.machine.state !== 'SECURITY_CHECK' && this.machine.canTransition('USER_ACTION_REQUIRED')) {
      this.machine.transition('USER_ACTION_REQUIRED', reason);
    } else {
      this.machine.force('USER_ACTION_REQUIRED', reason);
    }
    logger.warn(`USER ACTION REQUIRED: ${reason}`);
    this.emit();
  }

  private fail(message: string): void {
    this.hot = false;
    logger.error(`FAILED: ${message}`);
    this.machine.force('FAILED', message);
    this.detail = message;
    this.emit();
  }

  private handleError(error: unknown): void {
    if (error instanceof HaltForUser) {
      this.requireUser(error.userReason);
      return;
    }
    if (error instanceof SafeStop) {
      if (error.message === 'stopped' || error.message === 'aborted') return;
      this.fail(error.message);
      return;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.fail(message);
  }
}
