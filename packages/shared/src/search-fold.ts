/**
 * Persian folding for **matching a name against what somebody typed** (M22).
 *
 * ── Why this is not `normalize()` from `@payetam/domain` ─────────────────────
 *
 * ADR-0012's pipeline is the one true normalizer and this is deliberately not a
 * second copy of it. Two things separate them, and both are the reason this file
 * exists rather than an import:
 *
 *  - **Reachability.** `@payetam/domain` is a NestJS package. The Mini App and the
 *    admin panel cannot import it, and making them able to would drag Nest,
 *    Prisma and the whole domain layer into a bundle downloaded over an Iranian
 *    mobile connection (ADR-0003).
 *  - **Scope.** ADR-0012's pipeline is built to defeat *evasion*: it collapses
 *    repeated characters, strips Latin inserted mid-word and removes diacritics,
 *    all of which are lossy in ways that are correct for a blacklist and wrong
 *    for a city picker. Folding «سسسنندج» to «سنندج» is right when hunting a
 *    banned word and wrong when the user is choosing between real place names.
 *
 * What is kept is the part both need and neither can do without: the Arabic →
 * Persian letter folding, the zero-width characters, and case. Those are typing
 * habits, not evasion — an Arabic keyboard produces `ي` and `ك`, and «قائم‌شهر»
 * carries a ZWNJ that nobody types into a search box.
 *
 * This function and the `translate()` in migration 0021 that backfilled
 * `city.name_normalized` produce the same output for the 1,252 names in the
 * catalog, which is what makes a client-side filter and a server-side `LIKE`
 * agree about what matches.
 */

/** Arabic-script letters that render as their Persian counterparts. */
const LETTER_FOLDING: Record<string, string> = {
  ي: 'ی',
  ى: 'ی',
  ئ: 'ی',
  ك: 'ک',
  ة: 'ه',
  ۀ: 'ه',
  ھ: 'ه',
  ە: 'ه',
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ؤ: 'و',
};

/**
 * Fold a name or a query into the form the other one is compared against.
 *
 * Idempotent, so folding an already-folded string is safe — which matters because
 * `city.name_normalized` is stored folded and the query is folded on the way in.
 */
export function foldForSearch(input: string): string {
  return (
    input
      .normalize('NFC')
      .replace(/[يىئكةۀھەأإآٱؤ]/g, (char) => LETTER_FOLDING[char] ?? char)
      // ZWNJ is a real word separator in Persian, so it becomes a space: «قائم‌شهر»
      // and «قائم شهر» have to be the same thing to a search box.
      .replace(/\u200C/g, ' ')
      // The rest carry no lexical meaning and exist mid-word only by accident of
      // copy-paste: ZWSP, ZWJ, LRM, RLM, ALM and the BOM.
      //
      // Escapes, never literals — an invisible character pasted into source is one
      // a future edit deletes without anybody seeing it go, and the rule then
      // silently stops working. Alternation rather than a character class, because
      // ZWJ inside a class can fuse with its neighbours into one grapheme.
      .replace(/\u200B|\u200D|\u200E|\u200F|\u061C|\uFEFF/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/** Whether `haystack` contains `needle`, both folded. An empty needle matches. */
export function foldedIncludes(haystack: string, needle: string): boolean {
  const folded = foldForSearch(needle);
  return folded === '' || foldForSearch(haystack).includes(folded);
}
