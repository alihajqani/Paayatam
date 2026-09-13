import { describe, expect, it } from 'vitest';
import {
  adminQueueRows,
  formatAdminCasePrompt,
  formatAdminQueue,
  formatModerationDigest,
  moderationDigestKeyboard,
  type AdminCaseDetailLine,
  type AdminCaseLine,
} from './admin-cases';
import { parseAdminCallback } from './callback-data';

const CASE_ID = '11111111-1111-4111-8111-111111111111';

const line: AdminCaseLine = {
  id: CASE_ID,
  subjectType: 'EVENT',
  status: 'OPEN',
  trigger: 'AUTO_BLACKLIST',
  reportCount: 0,
  createdAt: new Date('2026-08-30T10:00:00.000Z'),
  eventTitle: 'شب بازی رومیزی',
};

const detail: AdminCaseDetailLine = {
  ...line,
  eventDescription: 'یک شب دوستانه برای بازی و گفتگو.',
  eventStatus: 'PENDING_MODERATION',
  reportReasons: [{ reason: 'SCAM', count: 6 }],
  matchedTermCount: 2,
};

describe('the moderation queue', () => {
  it('says so when there is nothing to do', () => {
    expect(formatAdminQueue([])).toContain('هیچ پروندهٔ بازی نیست');
    expect(adminQueueRows([])).toEqual([]);
  });

  /**
   * T9 on a body that reaches staff. An event title is host-authored text, and it
   * is on its way into an HTML message here exactly as it is everywhere else.
   */
  it('escapes a title that contains markup', () => {
    const body = formatAdminQueue([{ ...line, eventTitle: '<img src=x onerror=alert(1)>' }]);

    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
  });

  it('numbers the buttons to match the body', () => {
    const rows = adminQueueRows([line, { ...line, id: CASE_ID.replace('1111111', '2222222') }]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.[0]?.text).toContain('۱');
    expect(rows[1]?.[0]?.text).toContain('۲');
    expect(parseAdminCallback(rows[0]?.[0]?.callbackData ?? '')).toEqual({
      action: 'open',
      id: CASE_ID,
    });
  });
});

describe('one case, as the wizard asks about it', () => {
  it('shows an event in its own words, because they are already public', () => {
    const prompt = formatAdminCasePrompt(detail);

    expect(prompt).toContain('شب بازی رومیزی');
    expect(prompt).toContain('یک شب دوستانه');
  });

  it('counts report reasons rather than quoting the reporters', () => {
    const prompt = formatAdminCasePrompt(detail);

    expect(prompt).toContain('کلاهبرداری');
    expect(prompt).toContain('۶');
  });

  it('counts blacklist matches and never names them', () => {
    // `matched_terms` has always excluded the scanned text; this keeps one step
    // further back and shows only how many matched.
    expect(formatAdminCasePrompt(detail)).toContain('واژه‌های مسدود منطبق: ۲');
  });

  /**
   * Private conversations are behind break-glass — a permission, a case, a reason
   * and a fifteen-minute clock. A bot is not the surface for one, and a moderator
   * deciding on metadata alone should know that is what they are doing.
   */
  it('says when the content is not shown, rather than leaving a blank', () => {
    const message = formatAdminCasePrompt({
      ...detail,
      subjectType: 'MESSAGE',
      eventTitle: null,
      eventDescription: null,
      eventStatus: null,
    });

    expect(message).toContain('در ربات نشان داده نمی‌شود');
  });

  /**
   * `renderStep` escapes the prompt it is given, so anything with angle brackets
   * here would reach the moderator as visible entities.
   */
  it('emits no markup, because the wizard renderer escapes what it is given', () => {
    expect(formatAdminCasePrompt(detail)).not.toMatch(/<[^>]+>/);
  });

  /**
   * Trap 6's shape. Past Telegram's 4096 `sendMessage` answers 400, `classify()`
   * reads a bare 400 as retryable, and the message is retried until it
   * dead-letters — so a moderator taps «بررسی» and never hears back.
   */
  it('stays inside one Telegram message however long the event is', () => {
    const prompt = formatAdminCasePrompt({
      ...detail,
      // The contract's own ceiling for a description, which escaping can nearly
      // double on the way into an HTML message.
      eventDescription: 'ب'.repeat(2000),
      eventTitle: 'ت'.repeat(500),
      reportReasons: [
        { reason: 'SPAM', count: 3 },
        { reason: 'HARASSMENT', count: 2 },
        { reason: 'INAPPROPRIATE', count: 1 },
        { reason: 'SCAM', count: 1 },
        { reason: 'IMPERSONATION', count: 1 },
        { reason: 'SAFETY', count: 1 },
        { reason: 'OTHER', count: 1 },
      ],
    });

    // Half the limit, because the wizard renderer adds its own progress line and
    // Telegram counts the whole message.
    expect(prompt.length).toBeLessThanOrEqual(2048);
    expect(prompt).toContain('بریده شد');
    // The one line on the screen that cannot be lost to a ceiling: without it a
    // moderator is looking at evidence over two unexplained buttons.
    expect(prompt.endsWith('تصمیم شما چیست؟')).toBe(true);
  });
});

/**
 * Triage from the phone (plan 07).
 *
 * `triageCase` existed with the bot's own permission and nothing called it, so a
 * moderator could decide or walk away and nothing in between — two of them could
 * work one case at once without knowing, and one out of their depth had no way to
 * hand it to the panel.
 */
describe('triage on the queue', () => {
  function actions(
    assignment: NonNullable<AdminCaseLine['assignment']>,
    status = 'OPEN',
  ): string[] {
    return (adminQueueRows([{ ...line, status, assignment }])[0] ?? []).map((button) =>
      String(parseAdminCallback(button.callbackData)?.action),
    );
  }

  it('offers to claim an unclaimed case, and to hand it to the panel', () => {
    expect(actions('NONE')).toEqual(['open', 'claim', 'escalate']);
  });

  it('offers to release a case only to the moderator holding it', () => {
    expect(actions('ME', 'IN_REVIEW')).toEqual(['open', 'release', 'escalate']);
  });

  /** Somebody else has it: no claim to fight over, and no release that is not ours. */
  it('offers neither claim nor release on a case somebody else holds', () => {
    expect(actions('OTHER', 'IN_REVIEW')).toEqual(['open', 'escalate']);
  });

  it('does not offer to escalate what is already escalated', () => {
    expect(actions('ME', 'ESCALATED')).toEqual(['open', 'release']);
  });

  it('carries the case id on every triage button', () => {
    const rows = adminQueueRows([{ ...line, assignment: 'NONE' }]);
    for (const button of rows[0] ?? []) {
      expect(parseAdminCallback(button.callbackData)?.id).toBe(CASE_ID);
    }
  });

  it('says who holds a claimed case', () => {
    expect(formatAdminQueue([{ ...line, status: 'IN_REVIEW', assignment: 'ME' }])).toContain(
      'دست خودتان',
    );
    expect(formatAdminQueue([{ ...line, status: 'IN_REVIEW', assignment: 'OTHER' }])).toContain(
      'داور دیگری',
    );
  });

  /** The question this review started from: «کارهای ادمینی از تلگرام انجام نمی‌شود». */
  it('says the rest of the admin work is in the panel', () => {
    expect(formatAdminQueue([line])).toContain('پنل');
  });
});

/**
 * The digest a linked moderator receives (plan 06).
 *
 * Counts only: a Telegram message leaves the chat it was sent to, and a digest is
 * more likely to be forwarded than the queue itself — so no title, no report
 * text, nothing about who.
 */
describe('the moderation digest', () => {
  const NOW = new Date('2026-09-14T08:30:00.000Z');
  const summary = {
    openCount: 4,
    unclaimedCount: 3,
    oldestUnclaimedAt: new Date(NOW.getTime() - 150 * 60_000),
    bySubject: { EVENT: 2, USER: 1 },
  };

  it('says how many are waiting, how long, and what about', () => {
    const text = formatModerationDigest(summary, NOW);
    expect(text).toContain('۳ پرونده');
    expect(text).toContain('۲ ساعت');
    expect(text).toContain('فعالیت ۲');
    expect(text).toContain('کاربر ۱');
  });

  it('counts a fresh wait in minutes', () => {
    const text = formatModerationDigest(
      { ...summary, oldestUnclaimedAt: new Date(NOW.getTime() - 40 * 60_000) },
      NOW,
    );
    expect(text).toContain('۴۰ دقیقه');
  });

  it('opens the queue with its one button', () => {
    expect(
      moderationDigestKeyboard()
        .flat()
        .map((b) => b.callbackData),
    ).toEqual(['ad:list:x']);
  });
});
