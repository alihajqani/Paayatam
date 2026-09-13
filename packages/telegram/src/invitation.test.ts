import { describe, expect, it } from 'vitest';
import { renderEventInvitation, type EventInvitationContent } from './invitation';

const EVENT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const content: EventInvitationContent = {
  title: 'قهوه و بازی',
  categoryName: 'بازی',
  cityName: 'تهران',
  districtName: null,
  startsAt: new Date('2026-09-20T15:30:00.000Z'),
  capacity: 6,
  eventPublicId: EVENT,
  botUsername: 'payetam_bot',
};

/**
 * The paid invitation (review H3).
 *
 * A host spends thirty coins to put this in twenty strangers' chats, and its one
 * link opened the Mini App (`?startapp=`) — the surface being retired — instead
 * of the activity in the bot.
 */
describe('renderEventInvitation', () => {
  it('opens the activity in the bot', () => {
    const text = renderEventInvitation(content);
    expect(text).toContain(`href="https://t.me/payetam_bot?start=event_${EVENT}"`);
    expect(text).not.toContain('startapp');
  });

  /** The switch is on the settings board, not the profile-edit one. */
  it('says where the opt-out actually is', () => {
    const text = renderEventInvitation(content);
    expect(text).not.toContain('ویرایش پروفایل');
    expect(text).toContain('تنظیمات');
  });
});
