/**
 * The Persian normalization pipeline (ADR-0012).
 *
 * One module, used identically by moderation and search. That is the whole
 * decision: if the two ever normalize differently, one of them is wrong, and it
 * will be the moderation one — because search failures are reported by users and
 * moderation failures are not.
 *
 * Every rule is a separate exported pure function with its own test table, so a
 * normalization bug is localised to a few lines rather than to "the normalizer".
 * `normalize()` composes them in the order the ADR fixes.
 *
 * Normalization is deliberately lossy. `سلام` and `سسسلام` become the same
 * string, which is what defeats obfuscation and also what makes a legitimate
 * word capable of colliding with a banned one. The FLAG-by-default policy in
 * `BlacklistService` is what keeps that collision from blocking a real host.
 */

/** 1. Unicode NFC. Composed forms only, so a decomposed lookalike cannot slip past. */
export function toNfc(input: string): string {
  return input.normalize('NFC');
}

/**
 * 2. Arabic → Persian letter folding.
 *
 * `ي` (U+064A) and `ی` (U+06CC) render near-identically and are different code
 * points; the same is true of `ك`/`ک`. An Arabic keyboard produces the first of
 * each pair, so this is as often an honest typing habit as it is evasion — which
 * is exactly why search needs it too.
 */
const ARABIC_LETTER_FOLDING: Record<string, string> = {
  ي: 'ی', // ي → ی
  ى: 'ی', // ى (alef maksura) → ی
  ك: 'ک', // ك → ک
  ة: 'ه', // ة → ه
  أ: 'ا', // أ → ا
  إ: 'ا', // إ → ا
  آ: 'ا', // آ → ا
  ؤ: 'و', // ؤ → و
  ئ: 'ی', // ئ → ی
};

export function foldArabicLetters(input: string): string {
  return input.replace(/[يىكةأإآؤئ]/g, (char) => ARABIC_LETTER_FOLDING[char] ?? char);
}

/**
 * 3. Diacritic removal (اعراب).
 *
 * Fatha, kasra, damma, their tanwin forms, shadda, sukun, superscript alef. A
 * banned word sprinkled with harakat is the cheapest possible evasion, and
 * nobody types them in ordinary prose.
 */
export function removeDiacritics(input: string): string {
  return input.replace(/[ً-ْٰـ]/g, '');
}

/**
 * 4. Zero-width characters.
 *
 * ZWNJ (نیم‌فاصله, U+200C) becomes a space: it is a real word separator in
 * Persian, so `می‌روم` and `می روم` must land on the same tokens. ZWJ and the
 * bidi marks are stripped outright — they carry no lexical meaning and exist in
 * the middle of a word only to break a string match.
 */
export function foldZeroWidth(input: string): string {
  return (
    input
      // ZWNJ
      .replace(/\u200C/g, ' ')
      // ZWSP, ZWJ, LRM, RLM, ALM, BOM.
      //
      // Escapes, never literals. An invisible character pasted into source is one
      // a future edit deletes without anyone seeing it go, and the rule then
      // silently stops working — which is the failure mode this whole module
      // exists to prevent.
      //
      // Alternation rather than a character class, because ZWJ inside a class is
      // a joiner and can fuse with its neighbours into one grapheme; `[…‍…]`
      // therefore does not reliably mean "this code point on its own".
      .replace(/\u200B|\u200D|\u200E|\u200F|\u061C|\uFEFF/g, '')
  );
}

/** 5. Arabic-Indic (۰-۹) and Eastern Arabic (٠-٩) digits → Latin. */
export function unifyDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (char) => {
    const code = char.codePointAt(0)!;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** 6. Persian punctuation and quotes → ASCII, so one query form matches all of them. */
const PUNCTUATION_FOLDING: Record<string, string> = {
  '؟': '?', // ؟
  '،': ',', // ،
  '؛': ';', // ؛
  '«': '"', // «
  '»': '"', // »
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '٫': '.', // Arabic decimal separator
  '٬': ',', // Arabic thousands separator
};

export function unifyPunctuation(input: string): string {
  return input.replace(/[؟،؛«»‘’“”–—٫٬]/g, (char) => PUNCTUATION_FOLDING[char] ?? char);
}

/** 7. Collapse every run of whitespace to one space, and trim. */
export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * 8. Repetition collapse: three or more identical consecutive characters → one.
 *
 * Three, not two. Persian has legitimate doubled letters, and collapsing pairs
 * would fold real words together for no gain — `سسسلام` is evasion, `الله` is
 * not.
 */
export function collapseRepetition(input: string): string {
  return input.replace(/(.)\1{2,}/gu, '$1');
}

/**
 * 9a. Homoglyph mapping.
 *
 * ADR-0012 describes this step as folding "confusable Latin/Cyrillic characters
 * → their Persian equivalents". Implemented as written, that rule does not hold
 * up: Perso-Arabic shares no glyph shapes with Latin or Cyrillic, so any
 * `о`→`و` style mapping is invented rather than observed, and it would corrupt
 * legitimate Latin text in a title like «Board game night» for no gain.
 *
 * The real confusables for this script are *other Arabic-script* characters —
 * Urdu, Kurdish and Pashto letters that render almost identically to their
 * Persian counterparts and are one keyboard away. Those are what this table
 * folds. The Latin-character evasion the ADR was reaching for is a different
 * mechanism and is handled by `stripIntrusiveLatin` below.
 */
const HOMOGLYPH_FOLDING: Record<string, string> = {
  ھ: 'ه', // ھ  Urdu heh doachashmee
  ۀ: 'ه', // ۀ  heh with yeh above
  ە: 'ه', // ە  Kurdish ae
  ٿ: 'ت', // ٿ  theh with three dots above
  ٹ: 'ت', // ٹ  Urdu tteh
  ڊ: 'د', // ڊ  dal with dot below
  ڍ: 'د', // ڍ  ddahal
  ڕ: 'ر', // ڕ  Kurdish reh with small v
  ږ: 'ر', // ږ  Pashto reh
  ڛ: 'س', // ڛ  seen with three dots below
  ڪ: 'ک', // ڪ  swash kaf
  ګ: 'ک', // ګ  Pashto kaf with ring
  ڬ: 'ک', // ڬ  kaf with dot above
  ۍ: 'ی', // ۍ  Pashto yeh with tail
  ې: 'ی', // ې  Pashto e
  ٱ: 'ا', // ٱ  alef wasla
};

export function mapHomoglyphs(input: string): string {
  return input.replace(/[ھۀەٿٹڊڍڕږڛڪګڬۍېٱ]/g, (char) => HOMOGLYPH_FOLDING[char] ?? char);
}

/**
 * 9b. Strip Latin and Cyrillic characters **inserted** inside a Perso-Arabic word.
 *
 * The Latin-script evasion that actually works against a substring match is
 * noise insertion: `مشرrوب` reads as مشروب to a person because the eye skips the
 * intruder, while `includes()` sees a different string. Deleting the intruder
 * restores the word.
 *
 * **Substitution is deliberately not handled.** `مشrوب`, where `r` stands in
 * *for* `ر`, normalizes to `مشوب` and does not match — and it cannot be fixed by
 * deletion, only by a Latin→Persian lookalike table. No such table is credible
 * for this script: Perso-Arabic shares no glyph shapes with Latin, so every
 * entry would be an invented resemblance, and the cost of a wrong one is
 * corrupting legitimate mixed-script titles. Substitution is a known gap,
 * recorded in the verdict table and left to user reports (M12) — the second line
 * ADR-0012 says automated moderation needs.
 *
 * Only characters flanked by Perso-Arabic on *both* sides are removed, which is
 * what keeps «Board game night — بازی رومیزی» and «کافه Wi-Fi رایگان» intact:
 * their Latin runs border a space, not a letter.
 */
export function stripIntrusiveLatin(input: string): string {
  return input.replace(/(?<=[؀-ۿ])[A-Za-zЀ-ӿ]+(?=[؀-ۿ])/gu, '');
}

/**
 * 10. Case folding for embedded Latin.
 *
 * A tenth step, beyond the nine ADR-0012 enumerates. Without it a blacklist term
 * written in Latin script matches only the casing a moderator happened to type,
 * which is not a filter. It runs last so the Persian rules above are unaffected —
 * Persian has no letter case, so this touches only Latin and Cyrillic runs.
 */
export function foldCase(input: string): string {
  return input.toLowerCase();
}

/**
 * The composed pipeline, in ADR-0012's fixed order.
 *
 * Callers use this. The individual rules are exported for their tests and for
 * the rare caller that needs one in isolation — not so that a caller can build
 * its own variant of the pipeline, which is the failure mode the ADR exists to
 * prevent.
 */
export function normalize(input: string): string {
  return [
    toNfc,
    foldArabicLetters,
    removeDiacritics,
    foldZeroWidth,
    unifyDigits,
    unifyPunctuation,
    collapseWhitespace,
    collapseRepetition,
    mapHomoglyphs,
    stripIntrusiveLatin,
    foldCase,
  ].reduce((text, rule) => rule(text), input);
}

/**
 * The normalized text split into tokens.
 *
 * What "a whole word" means for an EXACT blacklist rule. Splitting on the
 * normalized string's spaces is enough because ZWNJ has already become one and
 * punctuation has already been unified — the tokenizer inherits every rule above
 * rather than restating any of them.
 */
export function tokenize(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}
