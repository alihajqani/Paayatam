import { describe, expect, it } from 'vitest';
import {
  CHAT_CALLBACK_ACTIONS,
  CODE_CALLBACK_KINDS,
  encodeChatCallback,
  encodeCodeCallback,
  isPublicId,
  parseChatCallback,
  parseCodeCallback,
  PROFILE_FIELD_KEYS,
  encodeProfileFieldCallback,
  parseProfileFieldCallback,
} from './callback-data';

const ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('the callback protocol', () => {
  it.each(CHAT_CALLBACK_ACTIONS)('round-trips %s', (action) => {
    expect(parseChatCallback(encodeChatCallback(action, ID))).toEqual({ action, id: ID });
  });

  /** The plan writes it as `chat:accept|reject:<id>`, and it is a wire format. */
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

  /**
   * A retired action fails the parse rather than being quietly accepted.
   *
   * `chat:close:<id>` is still sitting under old relayed messages in people's
   * Telegram history. It now answers «این دکمه دیگر کار نمی‌کند», which is what
   * it is — and the alternative, keeping the action parseable so the button
   * "works", would route a tap into a service that no longer exists.
   */
  it('no longer parses the conversation actions', () => {
    expect(parseChatCallback(`chat:close:${ID}`)).toBeNull();
    expect(parseChatCallback(`chat:share:${ID}`)).toBeNull();
    expect(parseChatCallback(`chat:shareyes:${ID}`)).toBeNull();
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

/**
 * The code-entry buttons (v0.6.4). They open a form and carry nothing else —
 * least of all a code, which is worth coins and would survive in the chat and in
 * anybody's screenshot of it.
 */
describe('the code-entry protocol', () => {
  it.each(CODE_CALLBACK_KINDS)('round-trips %s', (kind) => {
    expect(parseCodeCallback(encodeCodeCallback(kind))).toBe(kind);
  });

  it('encodes the documented three-part form', () => {
    expect(encodeCodeCallback('gift')).toBe('cd:gift:x');
    expect(encodeCodeCallback('ref')).toBe('cd:ref:x');
  });

  it.each([
    ['an unknown kind', 'cd:coupon:x'],
    ['another namespace', 'ad:gift:x'],
    ['a code smuggled into the value slot', 'cd:gift:SUMMER24'],
    ['a missing field', 'cd:gift'],
    ['nothing at all', ''],
  ])('%s parses to null', (_name, data) => {
    expect(parseCodeCallback(data)).toBeNull();
  });

  /** No parser may answer for another's data — the prefix is what tells them apart. */
  it('is not confused with a chat button, and does not confuse one', () => {
    expect(parseCodeCallback(encodeChatCallback('accept', ID))).toBeNull();
    expect(parseChatCallback(encodeCodeCallback('gift'))).toBeNull();
  });
});

describe('the profile-edit board callbacks (v0.9.1)', () => {
  it('round-trips every field', () => {
    for (const field of PROFILE_FIELD_KEYS) {
      expect(parseProfileFieldCallback(encodeProfileFieldCallback(field))).toBe(field);
    }
  });

  /** Telegram caps `callback_data` at 64 bytes and rejects the whole keyboard. */
  it('stays inside Telegram’s 64-byte budget', () => {
    for (const field of PROFILE_FIELD_KEYS) {
      expect(Buffer.byteLength(encodeProfileFieldCallback(field), 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  /**
   * A parser that accepted a neighbouring family's data would open a profile
   * form for a tap that meant something else entirely.
   */
  it('refuses anything that is not its own', () => {
    for (const data of ['pf:nope:-', 'pf:name', 'pf:name:1', 'cd:gift:-', '', 'pf::-']) {
      expect(parseProfileFieldCallback(data)).toBeNull();
    }
  });
});
