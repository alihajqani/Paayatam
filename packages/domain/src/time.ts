/**
 * Timezone arithmetic on the server clock (ADR-0008).
 *
 * Storage is UTC everywhere. These functions exist for the places where policy
 * is expressed in *local* terms — "five events per day", "cancelled more than 24
 * hours before" — because a user in Tehran means a Tehran day, and the server
 * may be running anywhere.
 *
 * Pure, and the timezone is always an explicit argument. `Date.getFullYear()`
 * and friends read the process's zone, which is an ambient global that differs
 * between a developer's laptop, CI and production.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(instant: Date, timeZone: string): ZonedParts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    // Named explicitly: `fa-IR` resolves to the Persian calendar and
    // Persian digits by default, and a policy threshold must not depend on
    // which locale chain the runtime happens to prefer.
    calendar: 'gregory',
    numberingSystem: 'latn',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = formatted.find((candidate) => candidate.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    // Intl renders midnight as hour 24 in some locales under hour12:false.
    hour: value('hour') % 24,
    minute: value('minute'),
    second: value('second'),
  };
}

/** The zone's UTC offset in milliseconds at a given instant. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = partsIn(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Whole seconds: the formatter has no millisecond field, so comparing at
  // millisecond precision would fold the instant's own sub-second part into the
  // offset.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The Gregorian year at an instant, in a given zone. */
export function gregorianYearIn(instant: Date, timeZone: string): number {
  return partsIn(instant, timeZone).year;
}

/**
 * The UTC instant at which the local day containing `instant` began.
 *
 * Computed in two passes. The first uses the offset in force *now* to guess when
 * local midnight was; the second re-reads the offset at that guess and corrects
 * it. The two differ only across a DST transition — Iran abolished DST in 2022,
 * so `Asia/Tehran` is a fixed +03:30 today — but this helper is also what M10's
 * cancellation thresholds will use, and a threshold that is silently wrong twice
 * a year in some future zone is not worth the five lines saved.
 */
export function startOfDayIn(instant: Date, timeZone: string): Date {
  const parts = partsIn(instant, timeZone);
  const localMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);

  const firstGuess = new Date(localMidnightAsUtc - offsetMsAt(instant, timeZone));
  return new Date(localMidnightAsUtc - offsetMsAt(firstGuess, timeZone));
}
