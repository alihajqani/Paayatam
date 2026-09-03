import { describe, expect, it } from 'vitest';
import { EVENT_DISCLAIMER_SHORT_FA, UNLIMITED_CAPACITY } from '@payetam/shared';
import { renderChannelPost, type ChannelPostContent } from './channel';

const BASE: ChannelPostContent = {
  kind: 'TRENDING',
  title: 'کافه‌گردی و گپ',
  categoryName: 'کافه‌گردی',
  cityName: 'مشهد',
  districtName: null,
  startsAt: new Date('2026-09-08T00:30:00.000Z'),
  capacity: 1,
  acceptedCount: 0,
  costType: 'FREE',
  costAmount: null,
  eventPublicId: '00000000-0000-4000-8000-000000000000',
  botUsername: 'payetam_bot',
};

function post(overrides: Partial<ChannelPostContent> = {}): string {
  return renderChannelPost({ ...BASE, ...overrides }).text;
}

/**
 * The post the channel actually shows (v0.7.0).
 *
 * It used to be a card — a kind label, the title in bold on its own line, five
 * facts — which reads like a listing, and a listing is not what somebody
 * scrolling a channel stops for. It now opens the way the person posting it
 * would, with the activity's name inside the sentence rather than above it.
 */
describe('the channel post', () => {
  it('is the disclaimer, the invitation, then the facts', () => {
    expect(post()).toBe(
      `${EVENT_DISCLAIMER_SHORT_FA}\n` +
        `پایه واسه <b>کافه‌گردی و گپ</b> میخوام\n` +
        `کیو داریم اینجا؟ بگه!\n` +
        `\n` +
        `🗂 کافه‌گردی\n` +
        `📍 مشهد\n` +
        `🗓 ۱۷ شهریور ۱۴۰۵ — ۰۴:۰۰\n` +
        `💸 رایگان\n` +
        `👥 ۱ جای خالی از ۱`,
    );
  });

  /** Above everything, because a liability line below the fold is unread. */
  it('puts the disclaimer first, before the activity is named', () => {
    const text = post();
    expect(text.indexOf(EVENT_DISCLAIMER_SHORT_FA)).toBe(0);
    expect(text.indexOf('کافه‌گردی و گپ')).toBeGreaterThan(0);
  });

  /** The kind headed the post until v0.7.0. Why the channel shows it is not news. */
  it.each(['VIP', 'BOOSTED', 'TRENDING', 'PAID'] as const)(
    'renders a %s post identically, with no kind label',
    (kind) => {
      expect(post({ kind })).toBe(post({ kind: 'TRENDING' }));
    },
  );

  describe('the facts', () => {
    it('names the neighbourhood when there is one', () => {
      expect(post({ districtName: 'ولنجک', cityName: 'تهران' })).toContain('📍 تهران، ولنجک');
    });

    it('says «رایگان» for a free activity, with no figure', () => {
      const text = post();
      expect(text).toContain('💸 رایگان');
      expect(text).not.toContain('تومان');
    });

    /** Six ungrouped digits are counted rather than read. */
    it('groups a price in threes', () => {
      expect(post({ costType: 'FIXED', costAmount: 250_000 })).toContain('💸 ۲۵۰,۰۰۰ تومان (ثابت)');
    });

    it('names a split without inventing a figure for it', () => {
      expect(post({ costType: 'SPLIT' })).toContain('💸 دنگی');
    });

    it('counts the seats left, and says when there are none', () => {
      expect(post({ capacity: 6, acceptedCount: 2 })).toContain('👥 ۴ جای خالی از ۶');
      expect(post({ capacity: 6, acceptedCount: 6 })).toContain('👥 ظرفیت تکمیل');
    });

    it('never counts down from an unlimited capacity', () => {
      expect(post({ capacity: UNLIMITED_CAPACITY, acceptedCount: 12 })).toContain(
        '👥 بدون محدودیت',
      );
    });

    /** Tehran, Jalali, Persian digits — the reader's calendar, not the column's. */
    it('renders the moment in the Persian calendar', () => {
      expect(post()).toContain('🗓 ۱۷ شهریور ۱۴۰۵ — ۰۴:۰۰');
    });
  });

  /**
   * Every interpolated value is host-authored and the channel is the widest
   * audience any of it reaches. `parse_mode` is HTML, so an unescaped angle
   * bracket is markup a host chose.
   */
  describe('escaping', () => {
    it('escapes the title, and keeps its own bold', () => {
      const text = post({ title: '<b>تخفیف</b> & رایگان' });

      expect(text).toContain('پایه واسه <b>&lt;b&gt;تخفیف&lt;/b&gt; &amp; رایگان</b> میخوام');
    });

    it('escapes the place and the category too', () => {
      const text = post({ cityName: 'تهران<', districtName: '>ولنجک', categoryName: '&کافه' });

      expect(text).toContain('📍 تهران&lt;، &gt;ولنجک');
      expect(text).toContain('🗂 &amp;کافه');
    });
  });

  /**
   * A post with no button is a post the channel cannot be reached *from*, which
   * was the whole of report 7.
   */
  describe('the buttons', () => {
    it('offers reading it and joining it, both into the bot', () => {
      const { keyboard } = renderChannelPost(BASE);

      expect(keyboard[0]?.[0]?.text).toContain('مشاهده در ربات');
      expect(keyboard[1]?.[0]?.text).toContain('پایتم');
      for (const button of keyboard.flat()) {
        expect(button.url).toContain('https://t.me/payetam_bot');
      }
    });

    it('degrades to the plain bot link rather than throwing on a bad id', () => {
      const { keyboard } = renderChannelPost({ ...BASE, eventPublicId: 'not a public id' });

      expect(keyboard).toHaveLength(1);
      expect(keyboard[0]?.[0]?.url).toBe('https://t.me/payetam_bot');
    });
  });
});
