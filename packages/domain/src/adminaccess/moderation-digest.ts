/**
 * Whether a moderator is told the queue has work in it (plan 06).
 *
 * ── Why a pure function ─────────────────────────────────────────────────────
 *
 * It is the one place the digest can be silently wrong. A digest that never
 * fires is indistinguishable from a quiet queue, and one that fires every quarter
 * hour through the night is how a moderator mutes the bot — so the decision is
 * kept free of I/O and tested as a table, for the reason `fanout.ts` gives for
 * being pure.
 *
 * ── The four conditions ─────────────────────────────────────────────────────
 *
 * - **Something nobody has picked up.** A claimed case has somebody on it (plan
 *   07); telling everybody about it again is noise.
 * - **Older than the delay.** A moderator who just closed the queue must not be
 *   pinged thirty seconds later about a case that arrived while they looked.
 * - **Past the quiet period** since the last digest to this moderator, or it
 *   becomes a message every quarter hour.
 * - **Waking hours in Tehran.** A queue that can wait until morning does not
 *   light up a phone at 3 a.m.; the worst case is a few hours, and ADR-0018
 *   names the panel for anything that cannot wait.
 */
export interface DigestInput {
  unclaimedCount: number;
  oldestUnclaimedAt: Date | null;
  lastDigestAt: Date | null;
  now: Date;
  tehranHour: number;
  delayMinutes: number;
  quietMinutes: number;
}

/** 08:00 inclusive to 23:00 exclusive, Tehran wall clock. */
const FIRST_HOUR = 8;
const LAST_HOUR = 23;

export function shouldSendDigest(input: DigestInput): boolean {
  if (input.unclaimedCount <= 0 || input.oldestUnclaimedAt === null) return false;
  if (input.tehranHour < FIRST_HOUR || input.tehranHour >= LAST_HOUR) return false;

  const waited = input.now.getTime() - input.oldestUnclaimedAt.getTime();
  if (waited < input.delayMinutes * 60_000) return false;

  if (input.lastDigestAt !== null) {
    const since = input.now.getTime() - input.lastDigestAt.getTime();
    if (since < input.quietMinutes * 60_000) return false;
  }
  return true;
}

const TEHRAN_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tehran',
  hour: 'numeric',
  hourCycle: 'h23',
});

/** The wall-clock hour in Tehran, 0–23. */
export function tehranHourOf(instant: Date): number {
  return Number(TEHRAN_HOUR.format(instant));
}
