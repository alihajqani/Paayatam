import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { TelegramMembershipProbe } from './membership.probe';

/**
 * Where the bot stands in a required channel (v0.16.0).
 *
 * The panel's `BOT_CANNOT_VERIFY` is built from this. Production had the gate on
 * over two channels and the bot was an administrator of one: every check in the
 * other answered «member list is inaccessible» and failed open, invisibly.
 */

function probeWith(getChatMember: (chat: string, user: number) => Promise<unknown>) {
  const probe = new TelegramMembershipProbe(
    { TELEGRAM_BOT_TOKEN: '7654321:secret-part' } as never,
    { client: {} } as never,
  );
  const spy = vi.fn(getChatMember);
  (probe as unknown as { bot: { api: { getChatMember: typeof spy } } }).bot.api.getChatMember = spy;
  return { probe, spy };
}

function telegramError(code: number, description: string): GrammyError {
  return new GrammyError(
    'Call to getChatMember failed',
    { ok: false, error_code: code, description },
    'getChatMember',
    {},
  );
}

describe('botStanding', () => {
  it('asks about the bot’s own id, taken from the token prefix', async () => {
    const { probe, spy } = probeWith(() => Promise.resolve({ status: 'administrator' }));

    await expect(probe.botStanding('@paayatam')).resolves.toBe('ADMIN');
    expect(spy).toHaveBeenCalledWith('@paayatam', 7654321);
  });

  it('reads a plain member as not an administrator', async () => {
    const { probe } = probeWith(() => Promise.resolve({ status: 'member' }));

    await expect(probe.botStanding('@paayatam')).resolves.toBe('NOT_ADMIN');
  });

  /** What Telegram actually answered for `@paayatam_news` on 2026-09-15. */
  it('reads «member list is inaccessible» as not an administrator', async () => {
    const { probe } = probeWith(() =>
      Promise.reject(telegramError(400, 'Bad Request: member list is inaccessible')),
    );

    await expect(probe.botStanding('@paayatam_news')).resolves.toBe('NOT_ADMIN');
  });

  it('tells a missing chat apart, and treats a rate limit as unknown', async () => {
    const missing = probeWith(() =>
      Promise.reject(telegramError(400, 'Bad Request: chat not found')),
    );
    await expect(missing.probe.botStanding('@nowhere')).resolves.toBe('CHAT_UNAVAILABLE');

    const limited = probeWith(() => Promise.reject(telegramError(429, 'Too Many Requests')));
    await expect(limited.probe.botStanding('@paayatam')).resolves.toBe('UNKNOWN');
  });

  it('answers unknown with no token at all', async () => {
    const probe = new TelegramMembershipProbe(
      { TELEGRAM_BOT_TOKEN: undefined } as never,
      { client: {} } as never,
    );

    await expect(probe.botStanding('@paayatam')).resolves.toBe('UNKNOWN');
  });
});
