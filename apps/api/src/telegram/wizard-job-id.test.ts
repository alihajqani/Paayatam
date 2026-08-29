import { describe, expect, it } from 'vitest';
import { jobId } from '@payetam/platform';

/**
 * The job ids `BotService` builds, checked against the guard that rejects them.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * `paint` built its id as `jobId('wizard', `${updateId}:${messageId}`)`. `jobId`
 * refuses a `:` because it would collide with BullMQ's own key namespace, so
 * **every wizard step after the first threw** — on every user, in production.
 *
 * It was invisible because `BotService.dispatch` catches everything: the webhook
 * must answer 200 (ADR-0004), so a throw becomes a log line. The conversation
 * still advanced in the database, and the integration tests asserted exactly
 * that — the step, the row, the event — and passed while nothing reached a
 * single user's screen. The wizard looked frozen after the first answer.
 *
 * ── Why this test and not a bigger one ──────────────────────────────────────
 *
 * The honest fix for "dispatch hides bugs" is not to stop catching — the webhook
 * contract requires it. It is to check the things that throw, at the point they
 * are built. Every id below is constructed the way the service constructs it.
 */
describe('the job ids BotService builds', () => {
  const UPDATE_ID = 151_151_300;
  const MESSAGE_ID = 489;

  it('accepts the wizard redraw id', () => {
    expect(jobId('wizard', String(UPDATE_ID), String(MESSAGE_ID))).toBe('wizard-151151300-489');
  });

  it('accepts the notification id', () => {
    expect(() => jobId('notify', '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f')).not.toThrow();
  });

  /** Telegram's callback query ids are digits, but the guard is what decides. */
  it('accepts the callback answer id', () => {
    expect(() => jobId('callback', '4382109371234567890')).not.toThrow();
  });

  /**
   * Deleting the user's own answer once the wizard has read it.
   *
   * Keyed on the **user and** the message. Telegram numbers messages per chat,
   * so two people's `message_id` collide routinely — an id built from the number
   * alone would let BullMQ absorb the second person's deletion as a duplicate,
   * and their answers would stay in the chat for no reason anybody could see.
   */
  it('accepts the tidy id, and keeps two users apart', () => {
    const first = jobId('tidy', '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f', String(MESSAGE_ID));
    const second = jobId('tidy', '0199bb22-3c4d-7e5f-9a01-2b3c4d5e6f70', String(MESSAGE_ID));

    expect(first).not.toBe(second);
    expect(first).toBe('tidy-0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f-489');
  });

  /**
   * The shape that shipped. Kept as a test so the next person who reaches for a
   * separator sees why the parts are separate arguments.
   */
  it('refuses the colon-joined form that broke production', () => {
    expect(() => jobId('wizard', `${String(UPDATE_ID)}:${String(MESSAGE_ID)}`)).toThrow(
      /only letters, digits/,
    );
  });
});
