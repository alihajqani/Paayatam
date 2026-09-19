import { localDateIn, startOfDayIn, zonedTimeToUtc } from '../time';

/**
 * What makes two seed events in one city look like two different evenings out
 * (see docs/superpowers/specs/2026-09-19-seed-event-floor-and-purge-design.md).
 *
 * Both pickers are pure and take their randomness as an argument, in the shape
 * of `pickSeedContent`: the caller supplies `Math.random`, a test supplies a
 * fixed sequence. Before this file existed every event of a pass got the first
 * active category, the same start instant (`now + 3h`) and the same duration,
 * which is exactly what a marketing event must not look like.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** How far ahead a seed event may be scheduled. */
export const SEED_HORIZON_DAYS = 14;

/**
 * The soonest a seed event may start. Enough for it to fill on the configured
 * cadence, and for a real user to see it while it is still ahead of them.
 */
export const SEED_MIN_LEAD_MS = 4 * HOUR_MS;

/**
 * Two events in one city never start closer than this. Real hosts do overlap,
 * but a feed whose fake events all begin at 18:00 is the tell this file exists
 * to remove.
 */
const CLASH_MS = 2 * HOUR_MS;

export type DayPart = 'MORNING' | 'AFTERNOON' | 'EVENING';

export const ALL_DAY_PARTS: readonly DayPart[] = ['MORNING', 'AFTERNOON', 'EVENING'];

/**
 * Local wall-clock starts a host might plausibly choose, tagged by part of the
 * day so a topic can say when it makes sense: a sunrise walk is not offered at
 * 19:30 and a film night is not offered at 10:00.
 */
const START_SLOTS: ReadonlyArray<{ part: DayPart; hour: number; minute: number }> = [
  { part: 'MORNING', hour: 9, minute: 30 },
  { part: 'MORNING', hour: 10, minute: 0 },
  { part: 'MORNING', hour: 11, minute: 0 },
  { part: 'AFTERNOON', hour: 15, minute: 0 },
  { part: 'AFTERNOON', hour: 16, minute: 0 },
  { part: 'AFTERNOON', hour: 17, minute: 0 },
  { part: 'EVENING', hour: 18, minute: 0 },
  { part: 'EVENING', hour: 18, minute: 30 },
  { part: 'EVENING', hour: 19, minute: 0 },
  { part: 'EVENING', hour: 19, minute: 30 },
  { part: 'EVENING', hour: 20, minute: 0 },
  { part: 'EVENING', hour: 20, minute: 30 },
];

const DURATIONS_MINUTES: readonly number[] = [90, 120, 150, 180];

/** Iran's weekend is Thursday (4) and Friday (5), by `Date#getUTCDay`. */
const WEEKEND_DAYS: ReadonlySet<number> = new Set([4, 5]);

/**
 * The category with the fewest upcoming events in this city, ties broken at
 * random.
 *
 * "Fewest" rather than "random" so a city topping up three events gets three
 * different categories instead of the same one twice by chance, and a city that
 * already has two hiking events is offered something else next.
 *
 * `candidates` must be non-empty; the caller has already applied everything that
 * makes a category eligible (active, not the catch-all, offered in the city).
 */
export function pickSeedCategory<T extends { id: string }>(input: {
  candidates: readonly T[];
  usedCounts: ReadonlyMap<string, number>;
  random: () => number;
}): T {
  const used = (category: T): number => input.usedCounts.get(category.id) ?? 0;
  const fewest = Math.min(...input.candidates.map(used));
  const pool = input.candidates.filter((category) => used(category) === fewest);
  return pool[Math.floor(input.random() * pool.length) % pool.length]!;
}

interface Candidate {
  startsAt: Date;
  weight: number;
}

/**
 * A start and an end for one seed event.
 *
 * Every (day, slot) in the next `SEED_HORIZON_DAYS` days is a candidate; the
 * ones that are too soon, in the wrong part of the day for the topic, or within
 * two hours of another event in the city are dropped; one of the rest is drawn
 * with a weight that favours nearer days, favours the weekend, and disfavours a
 * day the city already has an event on. If the city is so full that nothing
 * survives, the clash rule is relaxed rather than failing — a slightly crowded
 * evening is better than a floor that can never be reached.
 */
export function pickSeedSlot(input: {
  now: Date;
  timeZone: string;
  /** Start instants of the city's upcoming events, real and seeded. */
  takenStarts: readonly Date[];
  parts: readonly DayPart[];
  random: () => number;
}): { startsAt: Date; endsAt: Date } {
  const { now, timeZone, takenStarts, parts, random } = input;
  const allowed = parts.length > 0 ? parts : ALL_DAY_PARTS;

  const earliest = now.getTime() + SEED_MIN_LEAD_MS;
  const latest = now.getTime() + SEED_HORIZON_DAYS * 24 * HOUR_MS;
  const today = localDateIn(now, timeZone);

  const takenPerDay = new Map<number, number>();
  for (const taken of takenStarts) {
    const key = startOfDayIn(taken, timeZone).getTime();
    takenPerDay.set(key, (takenPerDay.get(key) ?? 0) + 1);
  }

  const build = (respectClash: boolean): Candidate[] => {
    const candidates: Candidate[] = [];
    for (let offset = 0; offset < SEED_HORIZON_DAYS; offset += 1) {
      const dayKey = zonedTimeToUtc(
        today.year,
        today.month,
        today.day + offset,
        0,
        0,
        timeZone,
      ).getTime();
      // `Date.UTC` carries a day past the end of the month, which is what makes
      // `today.day + offset` a valid argument above and here.
      const weekday = new Date(
        Date.UTC(today.year, today.month - 1, today.day + offset),
      ).getUTCDay();
      const nearness = 1 - offset / (SEED_HORIZON_DAYS + 6);
      const weekend = WEEKEND_DAYS.has(weekday) ? 1.5 : 1;
      const crowding = 1 / (1 + 2 * (takenPerDay.get(dayKey) ?? 0));

      for (const slot of START_SLOTS) {
        if (!allowed.includes(slot.part)) continue;
        const startsAt = zonedTimeToUtc(
          today.year,
          today.month,
          today.day + offset,
          slot.hour,
          slot.minute,
          timeZone,
        );
        const at = startsAt.getTime();
        if (at < earliest || at > latest) continue;
        if (
          respectClash &&
          takenStarts.some((taken) => Math.abs(taken.getTime() - at) < CLASH_MS)
        ) {
          continue;
        }
        candidates.push({ startsAt, weight: nearness * weekend * crowding });
      }
    }
    return candidates;
  };

  let candidates = build(true);
  if (candidates.length === 0) candidates = build(false);
  // Only reachable if every slot in the window is past the horizon or outside
  // the topic's parts of the day — a topic with no parts is normalised above, so
  // this is a belt-and-braces answer, not a path anyone is expected to take.
  if (candidates.length === 0) {
    candidates = [{ startsAt: new Date(earliest + HOUR_MS), weight: 1 }];
  }

  const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  let cursor = random() * total;
  let chosen = candidates[candidates.length - 1]!;
  for (const candidate of candidates) {
    cursor -= candidate.weight;
    if (cursor < 0) {
      chosen = candidate;
      break;
    }
  }

  const minutes =
    DURATIONS_MINUTES[Math.floor(random() * DURATIONS_MINUTES.length) % DURATIONS_MINUTES.length]!;
  return {
    startsAt: chosen.startsAt,
    endsAt: new Date(chosen.startsAt.getTime() + minutes * MINUTE_MS),
  };
}
