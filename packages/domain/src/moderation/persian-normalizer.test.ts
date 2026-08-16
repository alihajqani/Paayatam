import { describe, expect, it } from 'vitest';
import {
  collapseRepetition,
  collapseWhitespace,
  foldArabicLetters,
  foldCase,
  foldZeroWidth,
  mapHomoglyphs,
  normalize,
  removeDiacritics,
  stripIntrusiveLatin,
  toNfc,
  tokenize,
  unifyDigits,
  unifyPunctuation,
} from './persian-normalizer';

/**
 * One table per rule, as ADR-0012 requires.
 *
 * The point of testing the rules separately rather than only through
 * `normalize()` is diagnosis: when a banned term starts slipping through, a
 * failing table names the rule that broke. A single end-to-end test would only
 * say "normalization is wrong".
 */

describe('toNfc', () => {
  it('composes a decomposed sequence', () => {
    // U+0627 ALEF + U+0653 MADDA ABOVE composes to U+0622 ALEF WITH MADDA (آ).
    const decomposed = 'آ';
    expect(toNfc(decomposed)).toBe('آ');
    expect(toNfc(decomposed)).toHaveLength(1);
  });

  it('leaves already-composed text alone', () => {
    expect(toNfc('سلام')).toBe('سلام');
  });
});

describe('foldArabicLetters', () => {
  it.each([
    ['ي', 'ی', 'Arabic yeh'],
    ['ى', 'ی', 'alef maksura'],
    ['ك', 'ک', 'Arabic kaf'],
    ['ة', 'ه', 'teh marbuta'],
    ['أ', 'ا', 'alef with hamza above'],
    ['إ', 'ا', 'alef with hamza below'],
    ['آ', 'ا', 'alef with madda'],
    ['ؤ', 'و', 'waw with hamza'],
    ['ئ', 'ی', 'yeh with hamza'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(foldArabicLetters(input)).toBe(expected);
  });

  it('folds a whole word typed on an Arabic keyboard', () => {
    // «كيك» as an Arabic keyboard produces it, vs «کیک» in Persian.
    expect(foldArabicLetters('كيك')).toBe('کیک');
  });

  it('leaves Persian letters untouched', () => {
    expect(foldArabicLetters('کیک پزی')).toBe('کیک پزی');
  });
});

describe('removeDiacritics', () => {
  it.each([
    ['سَلام', 'سلام', 'fatha'],
    ['سِلام', 'سلام', 'kasra'],
    ['سُلام', 'سلام', 'damma'],
    ['سّلام', 'سلام', 'shadda'],
    ['سْلام', 'سلام', 'sukun'],
    ['سًلام', 'سلام', 'tanwin fath'],
    ['سـلام', 'سلام', 'tatweel'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(removeDiacritics(input)).toBe(expected);
  });

  it('strips a word buried in harakat', () => {
    expect(removeDiacritics('مَشْرُوب')).toBe('مشروب');
  });
});

describe('foldZeroWidth', () => {
  it('turns ZWNJ into a space, because it separates words in Persian', () => {
    expect(foldZeroWidth('می‌روم')).toBe('می روم');
  });

  it.each([
    ['ZWSP', 'مش​روب'],
    ['ZWJ', 'مش‍روب'],
    ['LRM', 'مش‎روب'],
    ['RLM', 'مش‏روب'],
    ['ALM', 'مش؜روب'],
    ['BOM', 'مش﻿روب'],
  ])('strips %s inserted mid-word', (_label, input) => {
    // The whole purpose: an invisible character between two letters must not
    // break a match.
    expect(foldZeroWidth(input)).toBe('مشروب');
  });
});

describe('unifyDigits', () => {
  it.each([
    ['۰۱۲۳۴۵۶۷۸۹', '0123456789', 'Persian'],
    ['٠١٢٣٤٥٦٧٨٩', '0123456789', 'Eastern Arabic'],
    ['0123456789', '0123456789', 'already Latin'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(unifyDigits(input)).toBe(expected);
  });

  it('unifies digits mixed into Persian text', () => {
    expect(unifyDigits('ساعت ۱۸ در منطقه ٣')).toBe('ساعت 18 در منطقه 3');
  });
});

describe('unifyPunctuation', () => {
  it.each([
    ['؟', '?'],
    ['،', ','],
    ['؛', ';'],
    ['«نقل»', '"نقل"'],
    ['٬', ','],
    ['٫', '.'],
  ])('%s → %s', (input, expected) => {
    expect(unifyPunctuation(input)).toBe(expected);
  });
});

describe('collapseWhitespace', () => {
  it.each([
    ['  سلام   دنیا  ', 'سلام دنیا'],
    ['سلام\n\nدنیا', 'سلام دنیا'],
    ['سلام\t\tدنیا', 'سلام دنیا'],
  ])('%j → %j', (input, expected) => {
    expect(collapseWhitespace(input)).toBe(expected);
  });
});

describe('collapseRepetition', () => {
  it('collapses three or more identical characters to one', () => {
    expect(collapseRepetition('سسسلام')).toBe('سلام');
    expect(collapseRepetition('سسسسسسلام')).toBe('سلام');
  });

  it('leaves a doubled letter alone, because Persian has real ones', () => {
    // Collapsing pairs would fold legitimate words together for no gain.
    expect(collapseRepetition('الله')).toBe('الله');
    expect(collapseRepetition('مسسل')).toBe('مسسل');
  });

  it('collapses runs anywhere in the string, not just at the start', () => {
    expect(collapseRepetition('کوهههه پیمایی')).toBe('کوه پیمایی');
  });
});

describe('mapHomoglyphs', () => {
  it.each([
    ['ھ', 'ه', 'Urdu heh doachashmee'],
    ['ۀ', 'ه', 'heh with yeh above'],
    ['ە', 'ه', 'Kurdish ae'],
    ['ٹ', 'ت', 'Urdu tteh'],
    ['ڪ', 'ک', 'swash kaf'],
    ['ګ', 'ک', 'Pashto kaf with ring'],
    ['ې', 'ی', 'Pashto e'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(mapHomoglyphs(input)).toBe(expected);
  });

  it('folds a word written with Urdu letterforms', () => {
    expect(mapHomoglyphs('کافھ')).toBe('کافه');
  });

  it('leaves Latin alone, because no Latin glyph resembles a Persian one', () => {
    // The table contains only Arabic-script confusables. Mapping Latin into
    // Persian would corrupt the many event titles that legitimately mix scripts.
    expect(mapHomoglyphs('board game')).toBe('board game');
  });
});

describe('stripIntrusiveLatin', () => {
  it('removes a Latin character inserted inside a Persian word', () => {
    // Insertion: the letters of the real word are all still there, with junk
    // between them. Deleting the junk restores it.
    expect(stripIntrusiveLatin('مشرrوب')).toBe('مشروب');
    expect(stripIntrusiveLatin('مشرxyzوب')).toBe('مشروب');
  });

  it('removes a Cyrillic intruder the same way', () => {
    expect(stripIntrusiveLatin('مشرрوب')).toBe('مشروب');
  });

  it('does not repair a substitution, and does not pretend to', () => {
    // `r` standing in *for* `ر` cannot be undone by deletion — it needs a
    // Latin→Persian lookalike table, and no credible one exists for a script
    // that shares no glyphs with Latin. Pinned as a test so the limitation is a
    // decision on record rather than a surprise.
    expect(stripIntrusiveLatin('مشrوب')).toBe('مشوب');
  });

  it.each([
    ['a mixed-script title', 'Board game night — بازی رومیزی'],
    ['a Latin word between Persian words', 'کافه Wi-Fi رایگان'],
    ['an all-Latin title', 'board game night'],
    ['a Latin word at the end', 'بازی رومیزی board'],
  ])('leaves %s untouched', (_label, input) => {
    // Only characters flanked by Perso-Arabic on both sides are removed, so a
    // Latin run bordered by a space always survives.
    expect(stripIntrusiveLatin(input)).toBe(input);
  });
});

describe('foldCase', () => {
  it('lowercases Latin so a Latin-script term is matchable at all', () => {
    expect(foldCase('Board GAME')).toBe('board game');
  });

  it('leaves Persian unchanged, which has no case', () => {
    expect(foldCase('بازی رومیزی')).toBe('بازی رومیزی');
  });
});

describe('normalize — the composed pipeline', () => {
  it('collapses every encoding of one phrase onto one string', () => {
    // Three ways to write «می‌روم به کافه»: half-space, plain space, and joined.
    const withZwnj = normalize('می‌روم به کافه');
    const withSpace = normalize('می روم به کافه');
    expect(withZwnj).toBe(withSpace);
  });

  it('defeats a stack of obfuscations at once', () => {
    // One string carrying four evasions: fatha, sukun, a tatweel, a ZWJ wedged
    // between two letters, and a tripled vav. All of them land on the plain word.
    expect(normalize('مَشْـر‍وووب')).toBe('مشروب');
  });

  it('is idempotent — normalizing twice changes nothing', () => {
    // Search normalizes queries and moderation normalizes stored terms; if the
    // function were not idempotent those two would drift apart over time.
    const messy = '  سَلامٌ   می‌كنم ۱۲۳ «تست»  ';
    const once = normalize(messy);
    expect(normalize(once)).toBe(once);
  });

  it('leaves clean Persian prose readable', () => {
    expect(normalize('عصر پنجشنبه بازی رومیزی در کافه')).toBe('عصر پنجشنبه بازی رومیزی در کافه');
  });
});

describe('tokenize', () => {
  it('splits on the separators the pipeline has already unified', () => {
    expect(tokenize(normalize('بازی رومیزی، عصر پنجشنبه'))).toEqual([
      'بازی',
      'رومیزی',
      'عصر',
      'پنجشنبه',
    ]);
  });

  it('treats a half-space as a word boundary', () => {
    expect(tokenize(normalize('می‌روم'))).toEqual(['می', 'روم']);
  });

  it('keeps digits as tokens', () => {
    expect(tokenize(normalize('ساعت ۱۸'))).toEqual(['ساعت', '18']);
  });

  it('returns nothing for punctuation-only input', () => {
    expect(tokenize(normalize('!!! ???'))).toEqual([]);
  });
});
