import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { InitDataValidator } from './init-data.validator';

/**
 * A fake bot token. Structurally valid, cryptographically meaningless, and not a
 * credential — the tests sign their own payloads with it.
 */
const BOT_TOKEN = '1234567890:TEST-TOKEN-NOT-A-REAL-CREDENTIAL-000';
const NOW = new Date('2026-06-01T12:00:00.000Z');

/** Signs initData exactly the way Telegram does, so the tests exercise real crypto. */
function signInitData(fields: Record<string, string>, token: string = BOT_TOKEN): string {
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

const validFields = (overrides: Record<string, string> = {}) => ({
  auth_date: String(Math.floor(NOW.getTime() / 1000)),
  query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
  user: JSON.stringify({
    id: 279058397,
    first_name: 'علی',
    last_name: 'حاجی',
    username: 'ali_test',
    language_code: 'fa',
  }),
  ...overrides,
});

const makeValidator = (clock = new FakeClock(NOW)) => new InitDataValidator(BOT_TOKEN, clock);

const expectCode = (fn: () => unknown, code: ErrorCode) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown, but nothing was`);
};

describe('InitDataValidator — acceptance', () => {
  it('accepts correctly signed, fresh initData', () => {
    const parsed = makeValidator().validate(signInitData(validFields()));

    expect(parsed.user.telegramUserId).toBe(279058397n);
    expect(parsed.user.firstName).toBe('علی');
    expect(parsed.user.username).toBe('ali_test');
    expect(parsed.user.languageCode).toBe('fa');
    expect(parsed.authDate).toEqual(NOW);
  });

  it('returns the telegram id as a bigint', () => {
    // Stored as BIGINT: ids have outgrown 32 bits and will eventually strain
    // Number.MAX_SAFE_INTEGER.
    const parsed = makeValidator().validate(
      signInitData(validFields({ user: JSON.stringify({ id: 8_000_000_123 }) })),
    );
    expect(parsed.user.telegramUserId).toBe(8000000123n);
  });

  it('exposes start_param for referral deep links', () => {
    const parsed = makeValidator().validate(
      signInitData(validFields({ start_param: 'ref_ABC123' })),
    );
    expect(parsed.startParam).toBe('ref_ABC123');
  });

  it('ignores the signature field when building the check string', () => {
    // Newer clients send an Ed25519 `signature`. It is not part of the HMAC payload;
    // including it would make login fail on exactly those clients and work
    // elsewhere — the worst kind of bug to diagnose in the field.
    const signed = signInitData(validFields());
    const withSignature = `${signed}&signature=abc123def456`;
    expect(() => makeValidator().validate(withSignature)).not.toThrow();
  });
});

describe('InitDataValidator — forgery and tampering', () => {
  it('rejects a tampered hash', () => {
    const signed = signInitData(validFields());
    const tampered = signed.replace(
      /hash=([0-9a-f]{64})/,
      (_m, h: string) =>
        // Flip one hex character.
        `hash=${h[0] === 'a' ? 'b' : 'a'}${h.slice(1)}`,
    );
    expectCode(() => makeValidator().validate(tampered), ErrorCode.INVALID_INIT_DATA);
  });

  it('rejects initData signed with a different bot token', () => {
    const forged = signInitData(validFields(), '9999999999:ATTACKER-TOKEN-000000000000000000');
    expectCode(() => makeValidator().validate(forged), ErrorCode.INVALID_INIT_DATA);
  });

  it('rejects a modified user id even though the rest is untouched', () => {
    // The attack this whole function exists to stop: swap the id, keep the hash.
    const signed = signInitData(validFields());
    const params = new URLSearchParams(signed);
    params.set('user', JSON.stringify({ id: 999, first_name: 'Attacker' }));
    expectCode(() => makeValidator().validate(params.toString()), ErrorCode.INVALID_INIT_DATA);
  });

  it('rejects an added field that was not signed', () => {
    const signed = signInitData(validFields());
    expectCode(
      () => makeValidator().validate(`${signed}&is_admin=true`),
      ErrorCode.INVALID_INIT_DATA,
    );
  });

  it.each([
    ['missing hash', () => new URLSearchParams(validFields()).toString()],
    ['empty string', () => ''],
    ['not a query string', () => 'complete-nonsense'],
    ['hash of the wrong length', () => `${new URLSearchParams(validFields()).toString()}&hash=abc`],
    [
      'hash that is not hex',
      () => `${new URLSearchParams(validFields()).toString()}&hash=${'z'.repeat(64)}`,
    ],
  ])('rejects %s', (_label, build) => {
    expectCode(() => makeValidator().validate(build()), ErrorCode.INVALID_INIT_DATA);
  });
});

describe('InitDataValidator — freshness', () => {
  it('rejects initData older than the freshness window', () => {
    const clock = new FakeClock(NOW);
    const signed = signInitData(validFields());
    clock.advance(301_000); // 5m 1s
    expectCode(() => makeValidator(clock).validate(signed), ErrorCode.INIT_DATA_EXPIRED);
  });

  it('accepts initData just inside the window', () => {
    const clock = new FakeClock(NOW);
    const signed = signInitData(validFields());
    clock.advance(299_000);
    expect(() => makeValidator(clock).validate(signed)).not.toThrow();
  });

  it('rejects initData dated far in the future', () => {
    const clock = new FakeClock(NOW);
    const future = String(Math.floor(NOW.getTime() / 1000) + 3600);
    const signed = signInitData(validFields({ auth_date: future }));
    expectCode(() => makeValidator(clock).validate(signed), ErrorCode.INVALID_INIT_DATA);
  });

  it.each([
    ['missing', ''],
    ['zero', '0'],
    ['negative', '-100'],
    ['not a number', 'yesterday'],
  ])('rejects auth_date that is %s', (_label, value) => {
    const fields = validFields();
    if (value === '') {
      delete (fields as Record<string, string>).auth_date;
    } else {
      fields.auth_date = value;
    }
    expectCode(() => makeValidator().validate(signInitData(fields)), ErrorCode.INVALID_INIT_DATA);
  });
});

describe('InitDataValidator — user payload', () => {
  it.each([
    ['absent user', undefined],
    ['malformed JSON', '{not json'],
    ['user without an id', JSON.stringify({ first_name: 'x' })],
    ['non-numeric id', JSON.stringify({ id: 'abc' })],
    ['zero id', JSON.stringify({ id: 0 })],
    ['negative id', JSON.stringify({ id: -5 })],
    ['fractional id', JSON.stringify({ id: 1.5 })],
  ])('rejects %s', (_label, user) => {
    const fields = validFields();
    if (user === undefined) {
      delete (fields as Record<string, string>).user;
    } else {
      fields.user = user;
    }
    expectCode(() => makeValidator().validate(signInitData(fields)), ErrorCode.INVALID_INIT_DATA);
  });

  it('omits optional fields rather than returning empty strings', () => {
    const parsed = makeValidator().validate(
      signInitData(validFields({ user: JSON.stringify({ id: 42, username: '' }) })),
    );
    expect(parsed.user.username).toBeUndefined();
    expect(parsed.user.firstName).toBeUndefined();
  });
});

describe('InitDataValidator — configuration', () => {
  it('refuses to construct without a bot token', () => {
    // A validator with no token would reject every login, which presents as a
    // client bug. Fail where the cause is visible.
    expect(() => new InitDataValidator('', new FakeClock(NOW))).toThrow(/bot token/i);
  });
});
