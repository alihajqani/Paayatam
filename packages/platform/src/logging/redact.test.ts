import { describe, expect, it } from 'vitest';
import { REDACTED, REDACTED_FIELDS, isSensitive, redact } from './redact';

/**
 * The log redactor (T15), and the plan's *"asserted against every sensitive field
 * name"*.
 *
 * The list is iterated rather than restated, so a field added to the redactor is
 * automatically covered and a field *removed* from it fails nothing silently — the
 * test cannot drift from the thing it tests because it reads it.
 *
 * The threat is not somebody logging a secret on purpose. It is a well-meaning
 * `logger.error({ err, request })` serialising a whole object, with the
 * interesting fields riding along.
 */
describe('every listed field is redacted, wherever it appears', () => {
  it.each(REDACTED_FIELDS)('%s at the top level', (field) => {
    const output = redact({ [field]: 'the-secret-value' }) as Record<string, unknown>;
    expect(output[field]).toBe(REDACTED);
  });

  it.each(REDACTED_FIELDS)('%s nested three deep', (field) => {
    const output = redact({ a: { b: { c: { [field]: 'the-secret-value' } } } });
    expect(JSON.stringify(output)).not.toContain('the-secret-value');
  });

  it.each(REDACTED_FIELDS)('%s inside an array', (field) => {
    const output = redact({ items: [{ [field]: 'the-secret-value' }] });
    expect(JSON.stringify(output)).not.toContain('the-secret-value');
  });

  /** A logger sees whichever casing the layer that produced the object used. */
  it('matches case-insensitively', () => {
    expect(isSensitive('TelegramUserId')).toBe(true);
    expect(isSensitive('TELEGRAM_USER_ID')).toBe(true);
    expect(isSensitive('Authorization')).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    const output = redact({ eventTitle: 'شب بازی', capacity: 6, publicId: 'abc' });
    expect(output).toEqual({ eventTitle: 'شب بازی', capacity: 6, publicId: 'abc' });
  });
});

/**
 * The net under the field list: a value that reaches a log through a *string*
 * rather than through a named field.
 */
describe('shapes are caught even when the field name is innocent', () => {
  it.each([
    ['a phone number', 'call me on +989121234567 please'],
    ['a phone number in local form', 'my number is 09121234567'],
    ['a bot token', 'using 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ['a t.me link', 'find me at https://t.me/leaky_handle'],
    ['a bearer token', 'Authorization was Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'],
  ])('%s in free text', (_label, text) => {
    const output = redact({ message: text }) as { message: string };
    expect(output.message).toContain(REDACTED);
  });

  /**
   * Deliberately narrow. A pattern matching "any long number" would redact prices,
   * counts and timestamps — and a redactor that mangles ordinary logs is one
   * somebody turns off.
   */
  it('does not redact ordinary numbers', () => {
    const output = redact({ message: 'capacity 6, 1200000 toman, at 1755248400000' }) as {
      message: string;
    };
    expect(output.message).not.toContain(REDACTED);
  });
});

describe('values that are not plain objects', () => {
  /** A ciphertext or a key. Neither is loggable; its length is all a diagnosis needs. */
  it('reduces binary to a length', () => {
    expect(redact(new Uint8Array([1, 2, 3, 4]))).toBe('[binary 4B]');
  });

  it('renders a bigint as a string rather than throwing on serialisation', () => {
    expect(redact(573_914_882n)).toBe('573914882');
  });

  it('keeps an error’s name and message, redacting the message', () => {
    const output = redact(new Error('failed for +989121234567')) as {
      name: string;
      message: string;
    };
    expect(output.name).toBe('Error');
    expect(output.message).toContain(REDACTED);
  });

  /**
   * A logger that can crash the process is worse than no logging, so depth is
   * capped rather than trusted.
   */
  it('survives a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;

    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });
});

/**
 * The realistic failure this exists to stop: somebody logs a whole request or a
 * whole row, and everything interesting goes with it.
 */
describe('the accident it is built for', () => {
  it('redacts a whole request object', () => {
    const output = redact({
      method: 'POST',
      url: '/api/v1/auth/telegram',
      headers: {
        authorization: 'Bearer secret-token',
        cookie: 'payetam_admin_session=abc',
        'user-agent': 'Telegram',
      },
      body: { initData: 'user=%7B%22id%22%3A573914882%7D&hash=deadbeef' },
      ip: '203.0.113.4',
    });

    const serialised = JSON.stringify(output);
    expect(serialised).not.toContain('secret-token');
    expect(serialised).not.toContain('573914882');
    expect(serialised).not.toContain('203.0.113.4');
    // And the diagnosable parts survive, or the log is useless.
    expect(serialised).toContain('/api/v1/auth/telegram');
    expect(serialised).toContain('Telegram');
  });

  it('redacts a whole telegram_account row', () => {
    const output = redact({
      id: 'row-1',
      userId: 'user-1',
      telegramUserId: 573_914_882n,
      usernameCached: 'leaky_handle',
      firstNameCached: 'Leaky',
      botBlocked: false,
    });

    const serialised = JSON.stringify(output);
    expect(serialised).not.toContain('573914882');
    expect(serialised).not.toContain('leaky_handle');
    expect(serialised).toContain('row-1');
  });

  it('redacts a whole chat_message row', () => {
    const output = redact({
      id: 'msg-1',
      seq: 4,
      bodyCiphertext: new Uint8Array([9, 9, 9]),
      bodyNonce: new Uint8Array([1, 1, 1]),
      keyVersion: 1,
    });

    const serialised = JSON.stringify(output);
    expect(serialised).toContain(REDACTED);
    expect(serialised).toContain('msg-1');
  });
});
