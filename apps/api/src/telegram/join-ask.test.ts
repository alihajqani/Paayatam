import { describe, expect, it } from 'vitest';
import { joinAsk, withdrawalCostLine } from './bot.service';

/**
 * What the bot says before a request is charged, and before one is withdrawn.
 *
 * ── Why these sentences have tests of their own ─────────────────────────────
 *
 * A production user in a city the product had not opened tapped «شرکت می‌کنم»
 * under three channel posts, paid twenty coins each without being shown a price
 * or a city, then withdrew all three on a confirmation that said «این کار
 * هزینه‌ای ندارد». Waiting would have returned every coin; withdrawing kept
 * them. Each branch below is a sentence that was missing that day.
 */
describe('joinAsk', () => {
  const base = {
    eventTitle: 'کوه نوردی',
    coins: 20,
    status: 'PENDING' as const,
  };

  it('names the price, when it comes back, and that a withdrawal keeps it', () => {
    const { text, label } = joinAsk(base);

    expect(text).toContain('«کوه نوردی»');
    expect(text).toContain('<b>۲۰ سکه</b>');
    expect(text).toContain('رد کند یا تا مهلت پاسخ ندهد');
    expect(text).toContain('خودتان درخواست را لغو کنید');
    expect(text).not.toContain('شهر');
    expect(label).toBe('✅ بله، درخواست بده');
  });

  it('says it is the waiting list, and when a waiting place pays back', () => {
    const { text, label } = joinAsk({ ...base, status: 'WAITLISTED' });

    expect(text).toContain('نوبت انتظار');
    expect(text).toContain('تا شروع رویداد');
    expect(label).toContain('نوبت انتظار');
  });

  it('escapes the host’s title, which is user text inside HTML', () => {
    const { text } = joinAsk({ ...base, eventTitle: '<b>بازی</b>' });

    expect(text).toContain('&lt;b&gt;بازی&lt;/b&gt;');
  });
});

describe('withdrawalCostLine', () => {
  const free = { coins: 0, trust: 0 };

  it('says a pending request keeps its charge, and that waiting would return it', () => {
    const line = withdrawalCostLine({ price: free, joinCharge: 20, status: 'PENDING' });

    expect(line).toContain('<b>۲۰ سکه‌ای</b>');
    expect(line).toContain('برنمی‌گردد');
    expect(line).toContain('رد کند یا تا مهلت پاسخ ندهد');
    expect(line).not.toContain('هزینه‌ای ندارد');
  });

  it('says when a waiting place would have paid back', () => {
    const line = withdrawalCostLine({ price: free, joinCharge: 20, status: 'WAITLISTED' });

    expect(line).toContain('تا شروع رویداد');
  });

  it('adds the late-cancellation fine to the forfeit rather than replacing it', () => {
    const line = withdrawalCostLine({
      price: { coins: 10, trust: 5 },
      joinCharge: 20,
      status: 'ACCEPTED',
    });

    expect(line).toContain('<b>۱۰ سکه</b>');
    expect(line).toContain('<b>۵ امتیاز</b>');
    expect(line).toContain('<b>۲۰ سکه‌ای</b>');
  });

  it('is free only when nothing is fined and nothing is kept', () => {
    expect(withdrawalCostLine({ price: free, joinCharge: 0, status: 'PENDING' })).toBe(
      'این کار هزینه‌ای ندارد.',
    );
  });
});
