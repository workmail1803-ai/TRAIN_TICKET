import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact } from '@/utils/logger';
import { DEFAULT_CONFIG, validateConfig } from '@/storage/storage-manager';
import { StateMachine } from '@/automation/state-machine';
import type { AppConfig } from '@/types';

/**
 * These are the guardrails. If any of them ever fails, the extension is doing something it
 * was explicitly built not to do.
 */

describe('log redaction', () => {
  it('never writes an OTP', () => {
    expect(redact('otp: 483920')).not.toContain('483920');
    expect(redact('PIN = 4821')).not.toContain('4821');
  });

  it('never writes a card number or CVV', () => {
    expect(redact('card 4111 1111 1111 1111')).not.toContain('4111');
    expect(redact('cvv: 123')).not.toContain('123');
  });

  it('never writes a password or a token', () => {
    expect(redact('password=hunter2')).not.toContain('hunter2');
    expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('never writes a CAPTCHA response', () => {
    expect(redact('g-recaptcha-response=03AGdBq26xyz')).not.toContain('03AGdBq26xyz');
  });

  it('never writes an NID number', () => {
    expect(redact('nid 1990123456789')).not.toContain('1990123456789');
    expect(redact('id 12345678901234567')).not.toContain('12345678901234567');
  });

  it('leaves ordinary diagnostics readable', () => {
    const message = 'Seat confirmed JHA-12 (2/4)';
    expect(redact(message)).toBe(message);
  });
});

describe('arming validation', () => {
  const base = (): AppConfig => structuredClone(DEFAULT_CONFIG);

  const complete = (): AppConfig => {
    const config = base();
    config.journey = { fromStation: 'Rajshahi', toStation: 'Dhaka', dateISO: '2026-08-20', searchClass: 'S_CHAIR' };
    config.preferences = { trainPriority: ['DHUMKETU EXPRESS', '', ''], classPriority: ['S_CHAIR'] };
    config.passengers = config.passengers.map((p, i) => ({
      ...p,
      name: `Passenger ${i + 1}`,
      age: '30',
      gender: 'Male',
    }));
    return config;
  };

  it('rejects an empty configuration rather than letting it arm', () => {
    expect(validateConfig(base()).length).toBeGreaterThan(0);
  });

  it('accepts a complete configuration', () => {
    expect(validateConfig(complete())).toEqual([]);
  });

  it('catches an incomplete passenger before the booking window, not during it', () => {
    const config = complete();
    config.passengers[2]!.name = '';
    const issues = validateConfig(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('Passenger 3');
  });

  it('only requires the profiles that will actually be used', () => {
    const config = complete();
    config.seatPolicy.targetSeats = 2;
    config.passengers[3]!.name = '';
    config.passengers[3]!.age = '';
    config.passengers[3]!.gender = '';
    expect(validateConfig(config)).toEqual([]);
  });

  it('refuses to book more seats than the site allows', () => {
    const config = complete();
    config.seatPolicy.targetSeats = 8;
    const issues = validateConfig(config);
    expect(issues.some((i) => i.field === 'seatPolicy.targetSeats')).toBe(true);
  });

  it('catches a same-origin-and-destination journey', () => {
    const config = complete();
    config.journey.toStation = 'Rajshahi';
    expect(validateConfig(config).some((i) => i.message.includes('same'))).toBe(true);
  });

  it('catches a malformed date', () => {
    const config = complete();
    config.journey.dateISO = '20-08-2026';
    expect(validateConfig(config).some((i) => i.field === 'journey.dateISO')).toBe(true);
  });

  it('requires at least one train and one class preference', () => {
    const config = complete();
    config.preferences.trainPriority = ['', '', ''];
    config.preferences.classPriority = [];
    const issues = validateConfig(config);
    expect(issues.some((i) => i.field === 'preferences.trainPriority')).toBe(true);
    expect(issues.some((i) => i.field === 'preferences.classPriority')).toBe(true);
  });
});

/**
 * The purchase commit is the user's action, by explicit instruction. These guard that at two
 * levels: no code path presses the button, and the state machine cannot even reach the state
 * that would represent having pressed it.
 */
describe('purchase commit is never automated', () => {
  const engineSource = readFileSync(
    resolve(process.cwd(), 'src/automation/booking-engine.ts'),
    'utf8'
  );

  it('the engine never clicks the CONTINUE PURCHASE control', () => {
    expect(engineSource).not.toMatch(/realClick\(\s*commit/);
    expect(engineSource).not.toMatch(/continuePurchase\s*\)?\s*\)?\s*;?\s*\n?\s*realClick/);
  });

  it('the engine does not resolve a commit button at all', () => {
    expect(engineSource).not.toMatch(/const\s+commit\s*=/);
  });

  it('SEATS_CONFIRMED cannot advance to the purchase-commit state', () => {
    const machine = new StateMachine();
    machine.force('SEATS_CONFIRMED', 'test');

    expect(machine.canTransition('PURCHASE_CONTINUE')).toBe(false);
    expect(machine.canTransition('USER_ACTION_REQUIRED')).toBe(true);
  });

  it('SEATS_CONFIRMED cannot skip straight to payment or success', () => {
    const machine = new StateMachine();
    machine.force('SEATS_CONFIRMED', 'test');

    expect(machine.canTransition('PAYMENT_REQUIRED')).toBe(false);
    expect(machine.canTransition('CONFIRMATION')).toBe(false);
    expect(machine.canTransition('SUCCESS')).toBe(false);
  });
});

describe('stored configuration shape', () => {
  it('has no field capable of holding a credential', () => {
    const keys = JSON.stringify(DEFAULT_CONFIG).toLowerCase();
    for (const forbidden of ['password', 'cvv', 'cardnumber', 'otp', 'captcha', 'token', 'pin']) {
      expect(keys).not.toContain(`"${forbidden}"`);
    }
  });

  it('defaults to the seat policy chosen by the user', () => {
    expect(DEFAULT_CONFIG.seatPolicy.targetSeats).toBe(4);
    expect(DEFAULT_CONFIG.seatPolicy.partial).toBe('TAKE_AVAILABLE_THEN_STOP');
    expect(DEFAULT_CONFIG.seatPolicy.coachSpread).toBe('PREFER_SINGLE_ALLOW_SPLIT');
  });

  it('keeps passenger autofill off until that page has been verified', () => {
    expect(DEFAULT_CONFIG.enablePassengerAutofill).toBe(false);
  });
});
