import { describe, expect, it } from 'vitest';
import {
  CHAT_NAME_DISCLOSURE_FA,
  CHAT_PRIVACY_SUMMARY_FA,
  CONTACT_SHARE_CONFIRM_FA,
} from './privacy';

/**
 * The privacy copy is a promise, so it is tested like a rule rather than read
 * like prose.
 *
 * Each assertion below names a fact the product either keeps or does not. The
 * one that matters most is the *absence*: the sentence this file replaced said
 * identity stays hidden «تا زمانی که خودشان نخواهند», which stopped being true
 * when ADR-0014 titled a conversation with the counterpart's display name. A test
 * that only checked for the presence of good sentences would have passed while
 * the misleading one sat beside them.
 */
describe('the chat privacy disclosure', () => {
  it('names the three identifiers that are never shown', () => {
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('شمارهٔ تلگرام');
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('نام کاربری');
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('شمارهٔ تماس');
  });

  it('admits that the display name and the activity title are visible', () => {
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('نام نمایشی');
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('عنوان همان فعالیت');
    expect(CHAT_NAME_DISCLOSURE_FA).toContain('نام نمایشی');
  });

  /**
   * Threat model R8, stated to the person it affects. ADR-0014 accepted the risk;
   * accepting a risk on a user's behalf without telling them is not acceptance.
   */
  it('admits that a host with several activities can correlate one person', () => {
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('چند فعالیت');
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('یک نفر');
  });

  it('says contact sharing needs an explicit confirmation', () => {
    expect(CHAT_PRIVACY_SUMMARY_FA).toContain('تأیید صریح');
  });

  it('no longer claims identity is hidden until the user wants otherwise', () => {
    for (const copy of [CHAT_PRIVACY_SUMMARY_FA, CHAT_NAME_DISCLOSURE_FA]) {
      expect(copy).not.toContain('تا زمانی که خودشان نخواهند');
      expect(copy).not.toContain('هویت دو طرف');
    }
  });

  it('describes contact sharing as unmasking the caller, not as a handover', () => {
    expect(CONTACT_SHARE_CONFIRM_FA).toContain('پنهان‌سازی روی پیام‌های خودتان');
    expect(CONTACT_SHARE_CONFIRM_FA).toContain('برگشت‌پذیر نیست');
    // The platform does not push anything to the counterpart, and the sentence
    // has to say so or «اشتراک اطلاعات تماس» reads as an automatic disclosure.
    expect(CONTACT_SHARE_CONFIRM_FA).toContain('به‌طور خودکار چیزی دریافت نمی‌کند');
  });
});
