import { escapeHtml } from './escape';
import { formatJalali, formatJalaliTime } from './wizard/jalali';

/** One direct message, as its recipient reads it. */
export interface DirectMessageLine {
  senderDisplayName: string;
  eventTitle: string;
  body: string;
  createdAt: Date;
}

/**
 * A direct message, opened (v0.7.0).
 *
 * ── Every message says who and about what ───────────────────────────────────
 *
 * Both, every time, in both directions. A host may be running three activities
 * and a guest may have written about three, so «سلام، ماشین دارید؟» with no
 * heading is a question about nothing in particular — and the notification that
 * announced it is one tap further up the chat, which on a phone is far enough to
 * be gone.
 *
 * ── The warning is under every one of them ──────────────────────────────────
 *
 * Not only in the compose prompt. The prompt catches the person about to type a
 * phone number; this catches the person about to *act* on one they have just been
 * sent. They are different people at different moments and both of them are
 * taking the risk.
 *
 * ── The body is escaped, and it is the only thing here that is dangerous ────
 *
 * It is a stranger's words on their way into an HTML-parse-mode message. So is
 * the display name, and so is the activity's title.
 */
export function formatDirectMessage(line: DirectMessageLine): string {
  return (
    `<b>✉️ پیام دربارهٔ «${escapeHtml(line.eventTitle)}»</b>\n` +
    `<i>از ${escapeHtml(line.senderDisplayName)} · ` +
    `${formatJalali(line.createdAt)} — ${formatJalaliTime(line.createdAt)}</i>\n\n` +
    `${escapeHtml(line.body)}\n\n` +
    `<i>⚠️ اگر شمارهٔ تماس یا شناسه‌ای رد و بدل می‌کنید، با احتیاط و به مسئولیت ` +
    `خودتان باشد؛ پایه‌تَم در این میان هیچ نقشی ندارد.</i>`
  );
}
