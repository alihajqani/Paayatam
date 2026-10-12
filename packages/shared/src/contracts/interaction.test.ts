import { describe, expect, it } from 'vitest';
import {
  INTERACTION_WIZARD_MARKS,
  interactionActionLabel,
  interactionNotificationLabel,
  interactionScreenLabel,
  interactionStepLabel,
  interactionWizardLabel,
  interactionWindowQuery,
} from './interaction';

/**
 * The names the «رفتار کاربران» pages show.
 *
 * Every one of these has the same contract: a Persian name when the key is
 * known, and **the key itself** when it is not. The vocabulary is open on
 * purpose — a new button, form or template needs no migration — so the labels
 * will always be a step behind the bot, and the report must show the newcomer
 * rather than hide it or crash on it.
 */
describe('interaction labels', () => {
  it('names a button, a command and a link', () => {
    expect(interactionActionLabel('ev:show')).toBe('دیدن جزئیات برنامه');
    expect(interactionActionLabel('start:campaign')).toBe('لینک کمپین');
    expect(interactionActionLabel('cmd:discover')).toBe('دستور: دیدن برنامه‌ها');
  });

  /** One destination reached three ways reads alike on all three rows. */
  it('names the same command the same way however it was reached', () => {
    expect(interactionActionLabel('kb:discover')).toBe('منوی پایین: دیدن برنامه‌ها');
    expect(interactionActionLabel('mn:c:discover')).toBe('منوی دکمه‌ای: دیدن برنامه‌ها');
  });

  it('names a form answer by its step', () => {
    expect(interactionActionLabel('wz:city')).toBe('فرم: جواب قدم city');
    expect(interactionActionLabel('wz:confirm')).toBe('فرم: ثبت نهایی');
  });

  it('shows an action nobody has named by its key', () => {
    expect(interactionActionLabel('zz:brand_new')).toBe('zz:brand_new');
    expect(interactionActionLabel('cmd:not_a_command')).toBe('دستور: not_a_command');
  });

  it('names a form, and falls back to its key', () => {
    expect(interactionWizardLabel('CREATE_EVENT')).toBe('ساختن برنامه');
    expect(interactionWizardLabel('SOME_NEW_FORM')).toBe('SOME_NEW_FORM');
  });

  it('names where a form stands', () => {
    expect(interactionStepLabel(INTERACTION_WIZARD_MARKS.SUMMARY)).toBe('بازبینی نهایی');
    expect(interactionStepLabel(INTERACTION_WIZARD_MARKS.CANCELLED)).toBe('بسته شد');
    expect(interactionStepLabel('title')).toBe('قدم title');
  });

  it('names a screen by what is on it, and falls back to the template key', () => {
    expect(interactionScreenLabel('bot.event_detail')).toBe('صفحهٔ برنامه');
    expect(interactionScreenLabel('participation.accepted')).toBe('participation.accepted');
  });

  /**
   * A message the product sent on its own is named by what it tells somebody,
   * and by who it tells — the same event reaches a host and a guest as two
   * different messages, and the return report compares them.
   */
  it('names a message the product sent, and falls back to its key', () => {
    expect(interactionNotificationLabel('participation.accepted')).toBe(
      'مهمان: درخواستت پذیرفته شد',
    );
    expect(interactionNotificationLabel('participation.requested.host')).toBe(
      'میزبان: درخواست تازه رسید',
    );
    // A reply template is a screen, and is still named rather than shown raw.
    expect(interactionNotificationLabel('bot.welcome')).toBe('خوش‌آمد');
    expect(interactionNotificationLabel('some.new_template')).toBe('some.new_template');
  });
});

describe('the report window', () => {
  it('defaults to thirty days', () => {
    expect(interactionWindowQuery.parse({})).toEqual({ days: 30 });
    expect(interactionWindowQuery.parse({ days: '7' })).toEqual({ days: 7 });
  });

  /** Longer than the retention period would read rows that are no longer there. */
  it('refuses a window longer than the rows are kept', () => {
    expect(interactionWindowQuery.safeParse({ days: 181 }).success).toBe(false);
    expect(interactionWindowQuery.safeParse({ days: 0 }).success).toBe(false);
  });
});
