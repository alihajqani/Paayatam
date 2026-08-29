import { CHAT_STATUS_FA, type ChatStatus } from '@payetam/shared';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';

/** One line of the conversation digest: who it is with, what it is about, where it stands. */
export interface MyChatLine {
  /** The other person, as this reader is allowed to see them (ADR-0014). */
  counterpartName: string;
  eventTitle: string;
  status: ChatStatus;
  /** Messages this reader has not read. Zero is not rendered. */
  unreadCount: number;
}

/**
 * `/chats` — the conversations the sender is in, most recently active first.
 *
 * ── Why this command exists at all ───────────────────────────────────────────
 *
 * The relay in `BotService.onText` already depends on it. A message typed into
 * the bot's DM names no conversation, so with two live chats open the bot cannot
 * guess and answers «چند گفتگوی باز دارید. روی پیام همان نفر Reply بزنید» — advice
 * that assumed the reader knows *which* conversations those are and can find a
 * message from each. Until now the only way to find that out was to open the Mini
 * App, which is precisely the trip the bot exists to save. This is the missing
 * half of a sentence the product was already saying.
 *
 * ── What it deliberately does not carry ──────────────────────────────────────
 *
 * No public id, and **no button per conversation.** A button would have to be a
 * reply-to-this-chat control, and that is per-user conversation state — the one
 * thing `BotService` holds none of, and the reason a redelivered update is
 * idempotent. The digest answers "what is open and who is waiting"; replying
 * stays exactly what `/help` already describes, which keeps one way to do it
 * rather than two that can disagree.
 *
 * Rendered here rather than in the service, and passed on as one `text` scalar,
 * for the reasons `formatMyRequests` and `formatMyEvents` give: Persian
 * presentation belongs beside every other message body, and a notification
 * payload holds scalars (invariant 7).
 *
 * `escapeHtml` on both the name and the title — a display name is a stranger's
 * words, and this is an HTML-parse-mode message.
 */
export function formatMyChats(lines: readonly MyChatLine[]): string {
  const entries = lines.map((line) => {
    // Zero unread renders nothing rather than «۰ پیام نخوانده»: a count of none
    // is not news, and a badge on every row is a badge on none.
    const unread =
      line.unreadCount > 0
        ? `\n  🔔 ${toPersianDigits(String(line.unreadCount))} پیام نخوانده`
        : '';

    return (
      `• <b>${escapeHtml(line.counterpartName)}</b>\n` +
      `  🎟 ${escapeHtml(line.eventTitle)}\n` +
      `  ${CHAT_STATUS_FA[line.status]}${unread}`
    );
  });

  return buildDigest({
    title: 'گفتگوهای شما',
    empty: 'گفتگوی بازی ندارید. از «دیدن رویدادها» یک فعالیت انتخاب کنید و درخواست پیوستن بفرستید.',
    entries,
  });
}
