import { describe, expect, it } from 'vitest';
import {
  CHAT_CALLBACK_ACTIONS,
  encodeChatCallback,
  isPublicId,
  parseChatCallback,
} from './callback-data';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('the callback protocol', () => {
  it.each(CHAT_CALLBACK_ACTIONS)('round-trips %s', (action) => {
    expect(parseChatCallback(encodeChatCallback(action, ID))).toEqual({ action, id: ID });
  });

  /** The plan writes it as `chat:accept|reject|close:<id>`, and it is a wire format. */
  it('encodes exactly the documented form', () => {
    expect(encodeChatCallback('accept', ID)).toBe(`chat:accept:${ID}`);
  });

  /**
   * 64 bytes is Telegram's limit and a UUID leaves 16 to spare, so a longer prefix
   * or a second field would not fit. Asserted so that adding one fails here rather
   * than in production, where the symptom is a `sendMessage` 400 on a message that
   * had always worked.
   */
  it('leaves the longest form inside 64 bytes', () => {
    const longest = CHAT_CALLBACK_ACTIONS.map((action) => encodeChatCallback(action, ID)).sort(
      (a, b) => b.length - a.length,
    )[0];

    expect(Buffer.byteLength(longest ?? '', 'utf8')).toBeLessThanOrEqual(64);
  });

  it('refuses to encode something Telegram would reject', () => {
    expect(() => encodeChatCallback('accept', 'x'.repeat(80))).toThrow(/64 bytes/);
  });
});

/**
 * Callback data arrives from a client, so a tampered value must fail the parse
 * rather than reach a service. Authorisation is not in the button — the services
 * check ownership — but a value that is not even a public id should never get that
 * far.
 */
describe('a tampered button', () => {
  it.each([
    ['an unknown action', `chat:delete:${ID}`],
    ['another namespace', `event:accept:${ID}`],
    ['an id that is not a public id', 'chat:accept:1'],
    ['SQL in the id', `chat:accept:'; drop table "user"; --`],
    ['a missing field', 'chat:accept'],
    ['an extra field', `chat:accept:${ID}:extra`],
    ['nothing at all', ''],
  ])('%s parses to null', (_name, data) => {
    expect(parseChatCallback(data)).toBeNull();
  });
});

describe('isPublicId', () => {
  it('accepts a UUID and rejects everything else', () => {
    expect(isPublicId(ID)).toBe(true);
    expect(isPublicId(ID.toUpperCase())).toBe(true);
    expect(isPublicId('')).toBe(false);
    expect(isPublicId('<img src=x onerror=alert(1)>')).toBe(false);
    expect(isPublicId(`${ID} `)).toBe(false);
  });
});
