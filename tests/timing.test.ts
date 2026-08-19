import { describe, expect, it } from 'vitest';
import {
  bstWallToEpoch,
  formatBst,
  nextBstOccurrence,
  parseClockTime,
  scheduleAt,
  zonedParts,
} from '@/utils/timing';

/**
 * These verify that scheduling is correct regardless of the machine's own timezone - the
 * whole point of deriving from Asia/Dhaka rather than trusting the local clock.
 */

describe('clock time parsing', () => {
  it('accepts HH:mm and HH:mm:ss', () => {
    expect(parseClockTime('08:00')).toEqual({ hour: 8, minute: 0, second: 0 });
    expect(parseClockTime('08:00:00')).toEqual({ hour: 8, minute: 0, second: 0 });
    expect(parseClockTime('23:59:59')).toEqual({ hour: 23, minute: 59, second: 59 });
  });

  it('throws instead of guessing at malformed input', () => {
    expect(() => parseClockTime('8am')).toThrow();
    expect(() => parseClockTime('25:00')).toThrow();
    expect(() => parseClockTime('08:70')).toThrow();
    expect(() => parseClockTime('')).toThrow();
  });
});

describe('Asia/Dhaka conversion', () => {
  it('places 08:00 Dhaka at 02:00 UTC (UTC+6, no DST)', () => {
    const epoch = bstWallToEpoch(2026, 8, 20, 8, 0, 0);
    const utc = new Date(epoch);
    expect(utc.getUTCHours()).toBe(2);
    expect(utc.getUTCMinutes()).toBe(0);
    expect(utc.getUTCDate()).toBe(20);
  });

  it('round-trips a wall time through the zone', () => {
    const epoch = bstWallToEpoch(2026, 8, 20, 8, 0, 0);
    const parts = zonedParts(epoch);
    expect(parts).toMatchObject({ year: 2026, month: 8, day: 20, hour: 8, minute: 0, second: 0 });
  });

  it('holds across a UTC day boundary, where a naive implementation drifts a day', () => {
    // 05:30 Dhaka on 1 Jan is 23:30 UTC on 31 Dec.
    const epoch = bstWallToEpoch(2027, 1, 1, 5, 30, 0);
    const utc = new Date(epoch);
    expect(utc.getUTCFullYear()).toBe(2026);
    expect(utc.getUTCMonth()).toBe(11);
    expect(utc.getUTCDate()).toBe(31);
    expect(utc.getUTCHours()).toBe(23);
    expect(zonedParts(epoch)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 5, minute: 30 });
  });
});

describe('next occurrence', () => {
  it('picks today when the time is still ahead', () => {
    const from = bstWallToEpoch(2026, 8, 20, 7, 45, 0);
    const target = nextBstOccurrence('08:00:00', from);
    expect(zonedParts(target)).toMatchObject({ year: 2026, month: 8, day: 20, hour: 8, minute: 0 });
    expect(target - from).toBe(15 * 60 * 1000);
  });

  it('rolls to tomorrow once the time has passed', () => {
    const from = bstWallToEpoch(2026, 8, 20, 8, 30, 0);
    const target = nextBstOccurrence('08:00:00', from);
    expect(zonedParts(target)).toMatchObject({ month: 8, day: 21, hour: 8 });
  });

  it('rolls across a month boundary', () => {
    const from = bstWallToEpoch(2026, 8, 31, 9, 0, 0);
    const target = nextBstOccurrence('08:00:00', from);
    expect(zonedParts(target)).toMatchObject({ year: 2026, month: 9, day: 1, hour: 8 });
  });

  it('treats the exact moment as already passed, so it never fires late by a day', () => {
    const from = bstWallToEpoch(2026, 8, 20, 8, 0, 0);
    const target = nextBstOccurrence('08:00:00', from);
    expect(zonedParts(target).day).toBe(21);
  });
});

describe('countdown', () => {
  it('fires exactly once', async () => {
    let fires = 0;
    await new Promise<void>((resolve) => {
      scheduleAt(Date.now() + 120, () => {
        fires++;
        resolve();
      });
    });
    // Give any stray timer a chance to misbehave before asserting.
    await new Promise((r) => setTimeout(r, 60));
    expect(fires).toBe(1);
  });

  it('never fires early — firing before the window opens lands on an error page', async () => {
    const target = Date.now() + 150;
    const firedAt = await new Promise<number>((resolve) => {
      scheduleAt(target, () => resolve(Date.now()));
    });
    expect(firedAt).toBeGreaterThanOrEqual(target - 1);
  });

  it('lands close to the target rather than on the next animation frame', async () => {
    const target = Date.now() + 150;
    const firedAt = await new Promise<number>((resolve) => {
      scheduleAt(target, () => resolve(Date.now()));
    });
    // The spin is sub-millisecond in practice; this bound is loose enough for a busy test
    // machine while still catching a regression to timer- or rAF-based waiting.
    expect(firedAt - target).toBeLessThan(30);
  });

  it('does not fire after cancellation', async () => {
    let fired = false;
    const handle = scheduleAt(Date.now() + 100, () => {
      fired = true;
    });
    handle.cancel();
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(false);
  });
});

describe('formatting', () => {
  it('renders Dhaka wall time regardless of the host timezone', () => {
    const epoch = bstWallToEpoch(2026, 8, 20, 8, 0, 0);
    expect(formatBst(epoch)).toMatch(/^2026-08-20 08:00:00\./);
  });
});
