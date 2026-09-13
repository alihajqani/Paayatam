import { describe, expect, it } from 'vitest';
import { shouldSendDigest, tehranHourOf, type DigestInput } from './moderation-digest';

const NOW = new Date('2026-09-14T08:30:00.000Z'); // 12:00 in Tehran
const MINUTE = 60_000;

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    unclaimedCount: 2,
    oldestUnclaimedAt: new Date(NOW.getTime() - 60 * MINUTE),
    lastDigestAt: null,
    now: NOW,
    tehranHour: 12,
    delayMinutes: 15,
    quietMinutes: 180,
    ...over,
  };
}

/**
 * Whether a moderator is told the queue has something in it (plan 06).
 *
 * A table, because this is the one place the feature can be silently wrong: a
 * digest that never fires looks exactly like a quiet queue, and one that fires
 * every quarter hour at 3 a.m. is how a moderator mutes the bot.
 */
describe('shouldSendDigest', () => {
  it('sends for an unclaimed case older than the delay, to somebody never told', () => {
    expect(shouldSendDigest(input())).toBe(true);
  });

  it('does not send when nothing is waiting for somebody to pick it up', () => {
    expect(shouldSendDigest(input({ unclaimedCount: 0, oldestUnclaimedAt: null }))).toBe(false);
  });

  /** A case a moderator is looking at right now should not ping them 30 s later. */
  it('waits out the delay on a brand-new case', () => {
    expect(
      shouldSendDigest(input({ oldestUnclaimedAt: new Date(NOW.getTime() - 5 * MINUTE) })),
    ).toBe(false);
    expect(
      shouldSendDigest(input({ oldestUnclaimedAt: new Date(NOW.getTime() - 15 * MINUTE) })),
    ).toBe(true);
  });

  it('stays quiet within the quiet period after the last digest', () => {
    expect(shouldSendDigest(input({ lastDigestAt: new Date(NOW.getTime() - 179 * MINUTE) }))).toBe(
      false,
    );
    expect(shouldSendDigest(input({ lastDigestAt: new Date(NOW.getTime() - 180 * MINUTE) }))).toBe(
      true,
    );
  });

  /** A queue that can wait until morning does not light up a phone at night. */
  it.each([
    [7, false],
    [8, true],
    [22, true],
    [23, false],
    [3, false],
  ])('at %i o’clock in Tehran sends: %s', (tehranHour, expected) => {
    expect(shouldSendDigest(input({ tehranHour }))).toBe(expected);
  });
});

describe('tehranHourOf', () => {
  it('reads the wall-clock hour in Tehran, not UTC', () => {
    expect(tehranHourOf(new Date('2026-09-14T08:30:00.000Z'))).toBe(12);
    expect(tehranHourOf(new Date('2026-09-13T20:29:00.000Z'))).toBe(23);
    expect(tehranHourOf(new Date('2026-09-13T20:31:00.000Z'))).toBe(0);
  });
});
