/**
 * The Persian text the platform itself says inside a chat.
 *
 * A message catalogue, not an i18n framework (plan §2.10). These are the strings
 * from docs/glossary-fa.md §4, kept here rather than in `packages/telegram`
 * because they are stored as SYSTEM messages in the conversation — both surfaces
 * render the same row, so there is one copy of the words and no way for the bot
 * and the Mini App to disagree about what the platform said.
 *
 * They are written into `chat_message` like any other message: encrypted, in
 * sequence, and subject to the same retention. The alternative — rendering them
 * at read time from a `kind` — means a conversation whose history changes when
 * the copy is edited, and a user reading a system notice they were never sent.
 */

/** Written as the first message of every chat, before anybody has typed. */
export const CHAT_ANONYMOUS_INTRO =
  'این گفتگو ناشناس است. نام، شماره تماس و شناسهٔ تلگرام شما نمایش داده نمی‌شود.';

/** On host acceptance, when the chat goes ANONYMOUS → OPEN. */
export const CHAT_OPENED =
  'درخواست شما پذیرفته شد. اکنون می‌توانید اطلاعات تماس را در صورت تمایل به اشتراک بگذارید.';

/** What a recipient sees in place of a message its sender deleted (D10). */
export const CHAT_MESSAGE_DELETED = '«پیام حذف شد»';

/** On close, whatever closed it. The reason stays on the row, not in the text. */
export const CHAT_CLOSED_NOTICE = 'این گفتگو بسته شد و امکان ارسال پیام تازه وجود ندارد.';

/**
 * On contact sharing. Named by alias, because that is all either side knows the
 * other by — and because the notice is a row both of them read.
 */
export function chatContactShared(alias: string): string {
  return `${alias} پذیرفت که اطلاعات تماس خود را در این گفتگو به اشتراک بگذارد.`;
}
