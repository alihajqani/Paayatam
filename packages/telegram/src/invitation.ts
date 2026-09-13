import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { formatTehran } from './datetime';
import { botStartUrl, encodeStartPayload } from './deep-link';
import { escapeHtml } from './escape';
import { MAIN_MENU_LABEL, menuPathFor } from './keyboards';
import { capacityLabel } from './seats';

/**
 * The invitation a host pays to send (M22 phase 11).
 *
 * Separate from `templates.ts` for the reason `channel.ts` is: those render a
 * `notification` row through a `TemplateKey`, and this is the body of a
 * `message_campaign` — stored once at purchase and delivered as written.
 *
 * ── Why the text is rendered at purchase rather than at send ─────────────────
 *
 * A campaign's `body_text` is what a dispute is about — "what did you send my
 * users?" — and a body composed at delivery time would answer that question with
 * whatever the event looks like *now*. Rendering once means the twenty recipients
 * all got the same message, and the row proves what it was.
 *
 * Every interpolated value goes through `escapeHtml`, because the title is
 * something a host typed and `parse_mode: 'HTML'` makes that a markup injection
 * point (T9).
 */
export interface EventInvitationContent {
  title: string;
  categoryName: string;
  cityName: string;
  districtName: string | null;
  startsAt: Date;
  capacity: number;
  eventPublicId: string;
  botUsername: string;
}

export function renderEventInvitation(content: EventInvitationContent): string {
  const where =
    content.districtName === null
      ? escapeHtml(content.cityName)
      : `${escapeHtml(content.cityName)}، ${escapeHtml(content.districtName)}`;

  return [
    '✉️ یک دعوت‌نامه برای شما',
    '',
    // Above the event (report 8). This message is an *advertisement* somebody paid
    // to put in a stranger's inbox, which makes it the place the disclaimer is
    // least optional and the place it must not sit under the fold.
    `<i>${escapeHtml(EVENT_DISCLAIMER_SHORT_FA)}</i>`,
    '',
    `<b>${escapeHtml(content.title)}</b>`,
    '',
    `🗂 ${escapeHtml(content.categoryName)}`,
    `📍 ${where}`,
    `🗓 ${formatTehran(content.startsAt)}`,
    `👥 ظرفیت ${capacityLabel(content.capacity)}`,
    '',
    // The deep link is built from the **public** id, the only identifier that ever
    // leaves the backend (invariant 7). `?start=` opens the activity in the bot,
    // as the channel post does; it was `?startapp=`, which opened the Mini App a
    // host was paying to send strangers to (review H3). `encodeStartPayload`
    // throws on an id Telegram would refuse, which is at purchase, not at a reader.
    `<a href="${escapeHtml(
      botStartUrl(content.botUsername, encodeStartPayload('event', content.eventPublicId)),
    )}">دیدن جزئیات و پایتم گفتن</a>`,
    '',
    // Said in the message rather than only in a settings screen: somebody who does
    // not want these should not have to go looking for how to stop them. The
    // switch is on the settings board, not the profile-edit one it used to name.
    `<i>اگر نمی‌خواهید دعوت‌نامه دریافت کنید، از «${MAIN_MENU_LABEL}» ← ` +
      `«${menuPathFor('settings') ?? 'حساب من'}» ← تنظیمات، «دریافت دعوت از میزبان‌ها» ` +
      `را خاموش کنید.</i>`,
  ].join('\n');
}
