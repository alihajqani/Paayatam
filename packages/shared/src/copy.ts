/**
 * Sentences the product says in more than one place.
 *
 * A module rather than a literal at each call site, for the reason
 * `apps/miniapp/src/copy/privacy.ts` gives about the privacy summary: a sentence
 * that appears in four surfaces and is edited in three of them is a sentence the
 * product is now telling different stories about. Here they are one string, in
 * `@payetam/shared` because the four surfaces are the Mini App, the bot's message
 * catalogue, the channel renderer and the admin panel — and `shared` is the only
 * package all of them already depend on.
 *
 * Wording follows `docs/glossary-fa.md`: «فعالیت», polite plural, no exclamation
 * marks.
 */

/**
 * The standing disclaimer, shown above every event (report 8).
 *
 * ── Why it is one constant ───────────────────────────────────────────────────
 *
 * It is a **liability statement**, which is the kind of string that must not
 * drift: the sentence on the event page and the sentence in the channel post have
 * to be the same sentence, or the one that is missing a clause is the one somebody
 * quotes back. `EVENT_DISCLAIMER_FA` is what the Mini App renders and what the
 * channel post and the bot's event messages carry.
 *
 * ── Why there is a short form ────────────────────────────────────────────────
 *
 * A Telegram channel post has a length budget and a scan pattern; a paragraph at
 * the top of every post is a paragraph readers learn to skip, which is the failure
 * mode a disclaimer cannot afford. `EVENT_DISCLAIMER_SHORT_FA` is the same claim
 * in one line, used where the full sentence would push the event's own details
 * below the fold. Both say the two things that matter — the platform is not
 * responsible, and the user must take care — so neither is a weaker version of the
 * other.
 */
export const EVENT_DISCLAIMER_FA =
  'پایه‌تَم هیچ مسئولیتی در قبال برگزاری این فعالیت و آنچه در آن رخ می‌دهد ندارد. ' +
  'مسئولیت حضور و تصمیم‌گیری با خود شماست؛ لطفاً احتیاط کنید.';

/** The one-line form, for a channel post and anywhere else space is the constraint. */
export const EVENT_DISCLAIMER_SHORT_FA =
  '⚠️ پایه‌تَم مسئولیتی در قبال این فعالیت ندارد؛ لطفاً احتیاط کنید.';
