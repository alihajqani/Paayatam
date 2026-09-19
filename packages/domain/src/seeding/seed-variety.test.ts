import { describe, expect, it } from 'vitest';
import { startOfDayIn } from '../time';
import {
  ALL_DAY_PARTS,
  SEED_HORIZON_DAYS,
  SEED_MIN_LEAD_MS,
  pickSeedCategory,
  pickSeedSlot,
} from './seed-variety';

const TEHRAN = 'Asia/Tehran';
const NOW = new Date('2026-08-15T09:00:00.000Z');

/** A small deterministic PRNG, so a distribution test cannot flake. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tehranHour(instant: Date): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: TEHRAN,
    hour: '2-digit',
    hour12: false,
  }).format(instant);
  return Number.parseInt(hour, 10) % 24;
}

describe('pickSeedCategory', () => {
  const categories = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('takes the category the city has the fewest events in', () => {
    const picked = pickSeedCategory({
      candidates: categories,
      usedCounts: new Map([
        ['a', 2],
        ['b', 1],
        ['c', 3],
      ]),
      random: () => 0.9,
    });
    expect(picked.id).toBe('b');
  });

  it('treats a category with no events as unused', () => {
    const picked = pickSeedCategory({
      candidates: categories,
      usedCounts: new Map([
        ['a', 1],
        ['b', 1],
      ]),
      random: () => 0,
    });
    expect(picked.id).toBe('c');
  });

  it('breaks a tie with the random source, and reaches every tied category', () => {
    const seen = new Set<string>();
    for (const r of [0, 0.34, 0.67, 0.99]) {
      seen.add(
        pickSeedCategory({ candidates: categories, usedCounts: new Map(), random: () => r }).id,
      );
    }
    expect(seen).toEqual(new Set(['a', 'b', 'c']));
  });

  it('three picks in a row, each recorded, name three different categories', () => {
    const random = mulberry32(7);
    const used = new Map<string, number>();
    const picked: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const category = pickSeedCategory({ candidates: categories, usedCounts: used, random });
      picked.push(category.id);
      used.set(category.id, (used.get(category.id) ?? 0) + 1);
    }
    expect(new Set(picked).size).toBe(3);
  });
});

describe('pickSeedSlot', () => {
  it('starts between the minimum lead and the horizon, and ends after it starts', () => {
    const random = mulberry32(1);
    for (let i = 0; i < 200; i += 1) {
      const slot = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: [],
        parts: ALL_DAY_PARTS,
        random,
      });
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + SEED_MIN_LEAD_MS);
      expect(slot.startsAt.getTime()).toBeLessThanOrEqual(
        NOW.getTime() + SEED_HORIZON_DAYS * 24 * 3_600_000,
      );
      const minutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
      expect([90, 120, 150, 180]).toContain(minutes);
    }
  });

  it('respects the part of the day a topic asks for', () => {
    const random = mulberry32(2);
    for (let i = 0; i < 100; i += 1) {
      const morning = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: [],
        parts: ['MORNING'],
        random,
      });
      expect(tehranHour(morning.startsAt)).toBeGreaterThanOrEqual(9);
      expect(tehranHour(morning.startsAt)).toBeLessThan(12);

      const evening = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: [],
        parts: ['EVENING'],
        random,
      });
      expect(tehranHour(evening.startsAt)).toBeGreaterThanOrEqual(18);
    }
  });

  it('spreads events over many days and many hours, not one instant', () => {
    const random = mulberry32(3);
    const days = new Set<number>();
    const hours = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const { startsAt } = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: [],
        parts: ALL_DAY_PARTS,
        random,
      });
      days.add(startOfDayIn(startsAt, TEHRAN).getTime());
      hours.add(tehranHour(startsAt));
    }
    expect(days.size).toBeGreaterThanOrEqual(8);
    expect(hours.size).toBeGreaterThanOrEqual(6);
  });

  it('never starts within two hours of an event the city already has', () => {
    const random = mulberry32(4);
    const taken: Date[] = [];
    for (let i = 0; i < 12; i += 1) {
      const { startsAt } = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: taken,
        parts: ALL_DAY_PARTS,
        random,
      });
      for (const other of taken) {
        expect(Math.abs(startsAt.getTime() - other.getTime())).toBeGreaterThanOrEqual(
          2 * 3_600_000,
        );
      }
      taken.push(startsAt);
    }
  });

  it('prefers a day with nothing on it over a day that already has events', () => {
    // Fill today+1 completely; a hundred draws should almost never land there.
    const random = mulberry32(5);
    const busyDay = startOfDayIn(new Date(NOW.getTime() + 24 * 3_600_000), TEHRAN).getTime();
    const taken = [16, 17, 18, 19, 20].map((hour) => new Date(busyDay + hour * 3_600_000));
    let onBusyDay = 0;
    for (let i = 0; i < 300; i += 1) {
      const { startsAt } = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: taken,
        parts: ALL_DAY_PARTS,
        random,
      });
      if (startOfDayIn(startsAt, TEHRAN).getTime() === busyDay) onBusyDay += 1;
    }
    expect(onBusyDay).toBeLessThan(15);
  });

  it('relaxes the clash rule rather than failing when the window is full', () => {
    // An event every 30 minutes for the whole horizon: no slot is two hours clear.
    const taken: Date[] = [];
    for (let at = NOW.getTime(); at < NOW.getTime() + 15 * 24 * 3_600_000; at += 30 * 60_000) {
      taken.push(new Date(at));
    }
    const slot = pickSeedSlot({
      now: NOW,
      timeZone: TEHRAN,
      takenStarts: taken,
      parts: ALL_DAY_PARTS,
      random: mulberry32(6),
    });
    expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + SEED_MIN_LEAD_MS);
  });

  it('treats an empty list of parts as any part', () => {
    const slot = pickSeedSlot({
      now: NOW,
      timeZone: TEHRAN,
      takenStarts: [],
      parts: [],
      random: mulberry32(8),
    });
    expect(slot.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('does not break on the edges of the random source', () => {
    for (const r of [0, 0.999999]) {
      const slot = pickSeedSlot({
        now: NOW,
        timeZone: TEHRAN,
        takenStarts: [],
        parts: ALL_DAY_PARTS,
        random: () => r,
      });
      expect(Number.isNaN(slot.startsAt.getTime())).toBe(false);
      expect(slot.endsAt.getTime()).toBeGreaterThan(slot.startsAt.getTime());
    }
  });
});
