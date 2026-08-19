import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, StateMachine } from '@/automation/state-machine';

describe('state machine', () => {
  it('starts idle', () => {
    expect(new StateMachine().state).toBe('IDLE');
  });

  it('walks the happy path as far as automation goes - seats selected, purchase left to the user', () => {
    const m = new StateMachine();
    const path = [
      'SITE_DETECTED', 'SESSION_READY', 'BOOKING_PAGE_READY', 'PREPARING', 'ARMED',
      'WAITING_FOR_BOOKING_OPEN', 'BOOKING_OPEN', 'ROUTE_READY', 'DATE_READY', 'SEARCHING',
      'RESULTS_READY', 'TRAIN_SELECTION', 'CLASS_SELECTION', 'SEAT_PANEL_READY',
      'COACH_SELECTION', 'SEAT_SELECTING', 'SEATS_CONFIRMED',
    ] as const;

    for (const state of path) m.transition(state);
    expect(m.state).toBe('SEATS_CONFIRMED');

    // The flow stops here and waits for the user to commit the purchase themselves.
    expect(m.canTransition('USER_ACTION_REQUIRED')).toBe(true);
    expect(m.canTransition('PURCHASE_CONTINUE')).toBe(false);
  });

  it('refuses a transition that was never declared', () => {
    const m = new StateMachine();
    // Skipping straight from idle to claiming seats must be impossible.
    expect(() => m.transition('SEAT_SELECTING')).toThrow(IllegalTransitionError);
    expect(m.state).toBe('IDLE');
  });

  it('never advances past a security check without the human', () => {
    const m = new StateMachine();
    m.transition('SITE_DETECTED');
    m.transition('SESSION_READY');
    m.transition('BOOKING_PAGE_READY');
    m.transition('PREPARING');
    m.transition('ARMED');
    m.transition('WAITING_FOR_BOOKING_OPEN');
    m.transition('BOOKING_OPEN');
    m.transition('SEARCHING');
    m.transition('SECURITY_CHECK');

    expect(() => m.transition('RESULTS_READY')).toThrow(IllegalTransitionError);
    m.transition('USER_ACTION_REQUIRED');
    expect(m.isWaitingOnHuman).toBe(true);

    // Only after the user confirms can the flow resume.
    m.transition('SECURITY_COMPLETE');
    m.transition('RESULTS_READY');
    expect(m.state).toBe('RESULTS_READY');
  });

  it('lets seat selection fall back to another coach or class, but not skip ahead', () => {
    const m = new StateMachine();
    m.force('SEAT_SELECTING', 'test');
    expect(m.canTransition('COACH_SELECTION')).toBe(true);
    expect(m.canTransition('CLASS_SELECTION')).toBe(true);
    expect(m.canTransition('CONFIRMATION')).toBe(false);
    expect(m.canTransition('SUCCESS')).toBe(false);
  });

  it('treats payment as a hand-over, never a step to automate through', () => {
    const m = new StateMachine();
    m.force('PAYMENT_REQUIRED', 'test');
    expect(m.canTransition('USER_PAYMENT_REQUIRED')).toBe(true);
    expect(m.canTransition('CONFIRMATION')).toBe(false);
    expect(m.canTransition('SUCCESS')).toBe(false);
  });

  it('allows STOP from anywhere via force, and marks terminal states', () => {
    const m = new StateMachine();
    m.force('SEAT_SELECTING', 'test');
    m.force('STOPPED', 'user pressed stop');
    expect(m.state).toBe('STOPPED');
    expect(m.isTerminal).toBe(true);
  });

  it('records every transition for the diagnostic log', () => {
    const m = new StateMachine();
    m.transition('SITE_DETECTED', 'host matched');
    m.transition('SESSION_READY', 'user menu');
    const history = m.transitions();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ from: 'IDLE', to: 'SITE_DETECTED', reason: 'host matched' });
  });

  it('notifies listeners on change', () => {
    const m = new StateMachine();
    const seen: string[] = [];
    m.onChange((state) => seen.push(state));
    m.transition('SITE_DETECTED');
    m.transition('SESSION_READY');
    expect(seen).toEqual(['SITE_DETECTED', 'SESSION_READY']);
  });
});
