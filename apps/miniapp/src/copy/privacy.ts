/**
 * What the product actually promises about identity, in the user's own language.
 *
 * These sentences live in a module rather than inline in `ChatsView` for one
 * reason: they are a **promise**, and a promise is the kind of string that goes
 * wrong silently. ADR-0014 changed what a conversation shows without changing the
 * sentence that described it, and the result sat in front of users for a
 * milestone saying identities stay hidden «تا زمانی که خودشان نخواهند» — true of
 * contact details, and never true of display names, which the host has read in
 * the participant list since M6.
 *
 * Keeping them here makes them assertable (`privacy.test.ts`), so the next change
 * to what is disclosed has to walk past a failing test rather than past a
 * paragraph nobody re-read.
 *
 * Wording follows `docs/glossary-fa.md`: «گفتگوی ناشناس», «نام مستعار»,
 * «فعالیت», polite plural, no exclamation marks.
 */

/**
 * The chat list's standing disclosure.
 *
 * Four facts in the order a reader needs them: how messages travel, what is never
 * shown, what *is* shown and to whom, and what the visible part implies. The last
 * clause is the one ADR-0014 owes the user — a host running several activities
 * can tell that the same person asked to join two of them, and saying so is
 * cheaper than being found out (threat model R8).
 */
export const CHAT_PRIVACY_SUMMARY_FA =
  'پیام‌ها از طریق ربات رد و بدل می‌شوند. شمارهٔ تلگرام، نام کاربری و شمارهٔ تماس شما هیچ‌وقت به ' +
  'طرف مقابل نشان داده نمی‌شود و اگر در متن پیام بیایند، پیش از ارسال پنهان می‌شوند. آنچه دیده ' +
  'می‌شود نام نمایشی پروفایل و عنوان همان فعالیت است — یعنی میزبانی که چند فعالیت دارد می‌تواند ' +
  'بفهمد هر دو درخواست از یک نفر است. اشتراک اطلاعات تماس فقط با تأیید صریح خودتان انجام می‌شود.';

/**
 * The line under a conversation's «نام — عنوان فعالیت» title.
 *
 * Short on purpose: the summary above already carries the explanation, and
 * repeating it per row would train people to skip both.
 */
export const CHAT_NAME_DISCLOSURE_FA = 'نام نمایشی و عنوان فعالیت برای طرف مقابل هم دیده می‌شود.';

/**
 * The contact-sharing confirmation, which is the one irreversible act on the
 * screen (criterion 6).
 *
 * It says what sharing *does* — stop masking the caller's own messages — rather
 * than implying the platform hands anything over, because a user who believes
 * their number was given away would be wrong in the direction that matters.
 */
export const CONTACT_SHARE_CONFIRM_FA =
  'پایه‌تَم شمارهٔ تماس شما را ندارد و نام کاربری تلگرامتان را به کسی نمی‌دهد. با این تأیید فقط ' +
  'پنهان‌سازی روی پیام‌های خودتان برداشته می‌شود تا اگر خواستید، اطلاعات تماستان را خودتان ' +
  'بفرستید. طرف مقابل به‌طور خودکار چیزی دریافت نمی‌کند و این کار برگشت‌پذیر نیست.';
