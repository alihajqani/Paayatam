import { describe, expect, it } from 'vitest';
import { needsReadingTime } from './telegram.client';

/**
 * How long a toast stays on screen (v0.7.0).
 *
 * The Bot API has no duration parameter — `answerCallbackQuery` takes `text`,
 * `show_alert`, `url` and `cache_time`, and none of them says "hold this for two
 * seconds". `show_alert` is the only lever: the same sentence as a dialog the
 * reader dismisses, so it cannot vanish before it has been read.
 *
 * The threshold is what stops that becoming a modal on every tap. A host
 * accepting five guests should not have to dismiss five dialogs saying
 * «پذیرفته شد».
 */
describe('needsReadingTime', () => {
  it('holds a refusal, which is the message somebody has to read', () => {
    expect(
      needsReadingTime(
        'پایتم گفتن به این فعالیت ۵ سکه هزینه دارد و موجودی شما ۲ سکه است.',
      ),
    ).toBe(true);
  });

  it('lets a bare acknowledgement pass as a toast', () => {
    expect(needsReadingTime('درخواست شما لغو شد')).toBe(false);
    expect(needsReadingTime('در لیست انتظار ثبت شدید ⏳')).toBe(false);
  });

  /** The silent acknowledgement every handler sends before doing its work. */
  it('is false for the empty answer', () => {
    expect(needsReadingTime('')).toBe(false);
    expect(needsReadingTime('   ')).toBe(false);
  });
});
