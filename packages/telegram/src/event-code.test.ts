import { describe, expect, it } from 'vitest';
import { eventCodeOf, eventCommandFor, parseEventCommand, publicIdPrefixOf } from './event-code';

const ID = '01a05d34-7820-7648-bc3d-240c16ee9285';

describe('the short code an activity is opened by', () => {
  it('is the first ten hex digits of the public id', () => {
    expect(eventCodeOf(ID)).toBe('01a05d3478');
  });

  /**
   * The code and the prefix are two spellings of the same eleven characters, and
   * the SQL asks for the second. If they ever disagree the link opens nothing,
   * so the round trip is the assertion.
   */
  it('round-trips into the prefix the query matches on', () => {
    const code = eventCodeOf(ID) as string;
    const prefix = publicIdPrefixOf(code) as string;

    expect(prefix).toBe('01a05d34-78');
    expect(ID.startsWith(prefix)).toBe(true);
    expect(prefix).toHaveLength(11);
  });

  it('renders a command Telegram will make tappable', () => {
    const command = eventCommandFor(ID) as string;

    expect(command).toBe('/event_01a05d3478');
    // Telegram's own rule for a bot command: 1–32 of `[A-Za-z0-9_]` after the
    // slash. A UUID is 36 and does not fit, which is why the code exists.
    expect(command.slice(1)).toMatch(/^[A-Za-z0-9_]{1,32}$/);
  });

  it('answers null rather than rendering a broken link', () => {
    expect(eventCodeOf('not-a-uuid')).toBeNull();
    expect(eventCommandFor('')).toBeNull();
  });
});

describe('reading the command back', () => {
  it('takes the code out of the command name', () => {
    expect(parseEventCommand('event_01a05d3478')).toBe('01a05d3478');
  });

  /**
   * `onCommand` lowercases before it dispatches, because Telegram's clients do
   * not agree on case. Hex survives that; an alphabet wider than hex would not,
   * which is half the reason the code is a slice of a UUID.
   */
  it('is case-insensitive, because the dispatcher lowercases', () => {
    expect(parseEventCommand('EVENT_01A05D3478')).toBe('01a05d3478');
  });

  it('is null for every other command', () => {
    expect(parseEventCommand('discover')).toBeNull();
    expect(parseEventCommand('event_')).toBeNull();
    expect(parseEventCommand('event_short')).toBeNull();
    expect(parseEventCommand('event_01a05d3478ff')).toBeNull();
    // Not hex — the `g` would have been silently truncated by a looser parser.
    expect(parseEventCommand('event_01a05d34gg')).toBeNull();
  });

  it('refuses a prefix built from anything but ten hex digits', () => {
    expect(publicIdPrefixOf('zzzzzzzzzz')).toBeNull();
    expect(publicIdPrefixOf('01a05d34')).toBeNull();
  });
});
