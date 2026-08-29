import { describe, expect, it } from 'vitest';
import { GrammyError, HttpError } from 'grammy';
import { classify } from './telegram.client';

/**
 * Which Telegram failures are worth another attempt (ADR-0005).
 *
 * The plan asks for two behaviours by name — *"429 honours `retry_after`"* and
 * *"403 marks `bot_blocked` and stops"* — and they are handled in different
 * places, deliberately.
 *
 * **429 never reaches this function.** grammY's `auto-retry` plugin sits beneath
 * the API call, reads `retry_after` from the response and sleeps for exactly that
 * long. That is the only correct response to a rate limit: a fixed backoff either
 * wastes time or returns too early and earns a longer penalty. If retries are
 * exhausted the 429 surfaces here and is classified `RETRY`, which is right — the
 * queue's own backoff is the next line of defence.
 *
 * **403 is classified here, as terminal.** It is not a failure to retry: there is
 * nobody at the other end, and retrying burns the global rate budget that other
 * users' notifications need.
 */

/** GrammyError's constructor wants the raw payload Telegram sent. */
function telegramError(code: number, description: string): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed',
    { ok: false, error_code: code, description },
    'sendMessage',
    {},
  );
}

describe('403 and its equivalents are terminal', () => {
  it('classifies a blocked bot as BLOCKED, not as something to retry', () => {
    const outcome = classify(telegramError(403, 'Forbidden: bot was blocked by the user'));

    expect(outcome.kind).toBe('BLOCKED');
  });

  it('classifies a deactivated account as BLOCKED', () => {
    expect(classify(telegramError(403, 'Forbidden: user is deactivated')).kind).toBe('BLOCKED');
  });

  /**
   * "Chat not found" is a 400 but is the same situation from the product's side:
   * there is no longer anybody to deliver to.
   */
  it('classifies a missing chat as BLOCKED', () => {
    expect(classify(telegramError(400, 'Bad Request: chat not found')).kind).toBe('BLOCKED');
  });
});

/**
 * A 429 that survived `auto-retry` is retryable *and* worth naming (M22 phase 4).
 *
 * It stayed `RETRY` until M22 and could not be told apart from a socket hang-up,
 * which is fine for one notification and wrong for a four-thousand-recipient
 * campaign: a rate limit that got past both the plugin's `retry_after` sleep and
 * BullMQ's global limiter means Telegram is asking us to stop, and pushing on is
 * how a bot gets restricted. Its own kind is what lets a campaign's circuit
 * breaker see it.
 */
describe('a rate limit is retryable, and says so', () => {
  it('classifies a 429 as RATE_LIMITED rather than as a generic retry', () => {
    const outcome = classify(telegramError(429, 'Too Many Requests: retry after 30'));

    expect(outcome.kind).toBe('RATE_LIMITED');
    expect(outcome.kind === 'RATE_LIMITED' && outcome.reason).toContain('429');
  });

  it('carries retry_after when Telegram supplied one', () => {
    const error = new GrammyError(
      'Call to sendMessage failed',
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 12',
        parameters: { retry_after: 12 },
      },
      'sendMessage',
      {},
    );

    const outcome = classify(error);
    expect(outcome.kind === 'RATE_LIMITED' && outcome.retryAfterSeconds).toBe(12);
  });

  it('reports null rather than guessing when Telegram supplied none', () => {
    const outcome = classify(telegramError(429, 'Too Many Requests'));

    expect(outcome.kind === 'RATE_LIMITED' && outcome.retryAfterSeconds).toBeNull();
  });
});

describe('everything else is retryable', () => {
  it('keeps a server error retryable', () => {
    expect(classify(telegramError(500, 'Internal Server Error')).kind).toBe('RETRY');
  });

  /**
   * A malformed request is **our** bug, not the user's. Retryable-and-loud, so it
   * exhausts into `job_failure` where somebody can see it — rather than being
   * quietly filed as "undeliverable" and marking an innocent account as having
   * blocked the bot.
   */
  it('keeps a bad request retryable rather than blaming the recipient', () => {
    expect(classify(telegramError(400, "Bad Request: can't parse entities")).kind).toBe('RETRY');
  });

  it('keeps a network failure retryable', () => {
    expect(
      classify(new HttpError('network request failed', new Error('socket hang up'))).kind,
    ).toBe('RETRY');
  });

  it('keeps an unrecognised error retryable', () => {
    expect(classify(new Error('something unexpected')).kind).toBe('RETRY');
    expect(classify('not even an error').kind).toBe('RETRY');
  });
});
