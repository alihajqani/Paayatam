import { describe, expect, it } from 'vitest';
import { BlacklistService, type BlacklistRule } from './blacklist.service';
import { normalize } from './persian-normalizer';
import { STARTER_BLACKLIST } from './starter-blacklist';
import { decisionFor } from './moderation.service';

/**
 * The matcher, against the **real** list.
 *
 * A test over three invented terms proves the regex engine works and proves
 * nothing about whether «شرابخواری» publishes — which is the question the first
 * QA round asked and the deployed list answered wrongly. So the rules here are
 * built from `STARTER_BLACKLIST` through the same `normalize()` the seed and
 * migration 0037 use, and the assertions are about words a host might actually
 * type.
 *
 * `match` touches no database — the rules are handed to it — so the service is
 * constructed without one. That is the shape `BlacklistService` was written in:
 * `load` reads, `match` decides, and only the first needs Prisma.
 */
const service = new BlacklistService(null as never);

const rules: BlacklistRule[] = STARTER_BLACKLIST.map((term, index) => ({
  id: `rule-${String(index)}`,
  termRaw: term.termRaw,
  // REGEX patterns are matched against normalized text but are not themselves
  // Persian prose — normalizing `\d{9}` would mangle the pattern.
  termNormalized: term.patternType === 'REGEX' ? term.termRaw : normalize(term.termRaw),
  patternType: term.patternType,
  severity: term.severity,
  category: term.category,
}));

const verdict = (text: string) => decisionFor(service.match(text, rules));
const matched = (text: string) => service.match(text, rules).map((m) => m.termRaw);

describe('the words that must not publish', () => {
  /**
   * The report, verbatim: this listing went live. The deployed list held
   * «مشروب», and «شرابخواری» does not contain it — the stem it contains is
   * «شراب», which was not on the list at all.
   */
  it('blocks a drinking event however the compound is written', () => {
    expect(verdict('شرابخواری جمعه شب')).toBe('BLOCK');
    expect(verdict('شراب‌خواری جمعه شب')).toBe('BLOCK');
    expect(verdict('شراب خوری جمعه شب')).toBe('BLOCK');
    expect(verdict('یک شب با شراب قرمز')).toBe('BLOCK');
  });

  /**
   * The second half of the same report: the sample activity's description held
   * «صیغه» and it published, because FLAG publishes. The word is a genuine legal
   * term, so it stays EXACT — but an activity offering it has one reading.
   */
  it('blocks a solicitation listing rather than queueing it', () => {
    expect(verdict('دورهمی کافه\nبرای آشنایی و صیغه')).toBe('BLOCK');
    expect(verdict('ازدواج موقت با شرایط ویژه')).toBe('BLOCK');
  });

  it('blocks the rest of what a listing must not offer', () => {
    expect(verdict('شب پوکر')).toBe('BLOCK');
    expect(verdict('کازینو آنلاین')).toBe('BLOCK');
    expect(verdict('فروش ودکا و ویسکی')).toBe('BLOCK');
    expect(verdict('تیراندازی با اسلحه')).toBe('BLOCK');
    expect(verdict('گل کشیدن در طبیعت')).toBe('BLOCK');
  });

  /**
   * The whole argument for EXACT, and the reason SUBSTRING is not the default.
   * A blocked innocent host is the worse outcome (ADR-0012), and these are the
   * words that would produce one.
   */
  it('leaves the innocent words the stems sit inside alone', () => {
    expect(matched('بازدید از بنگاه املاک')).toEqual([]);
    expect(matched('درمان سکسکه')).toEqual([]);
    // «عرق» on its own is sweat, and a herbal distillate sold in every grocery.
    expect(matched('عرق نعناع خانگی')).toEqual([]);
    // «گل» alone is a flower, a goal and a common name.
    expect(matched('گل‌کاری در باغ')).toEqual([]);
    expect(matched('کارگاه عکاسی')).toEqual([]);
  });

  /**
   * FLAG publishes and opens a case — unchanged, and the reason «شیشه» is not
   * BLOCK: a glass-fronted café must not be refused, and a human decides.
   */
  it('flags the ambiguous rather than refusing it', () => {
    expect(verdict('کافه شیشه‌ای')).toBe('FLAG');
    expect(verdict('ژل الکل همراه بیاورید')).toBe('FLAG');
    expect(verdict('هماهنگی: 09121234567')).toBe('FLAG');
    expect(verdict('کانال ما: t.me/example')).toBe('FLAG');
  });

  it('says nothing about ordinary activities', () => {
    expect(verdict('کوهنوردی صبح جمعه — درکه')).toBe('CLEAN');
    expect(verdict('شب بازی رومیزی در کافه، با تخته نرد و منچ')).toBe('CLEAN');
    expect(verdict('پیاده‌روی در پارک و عکاسی از گل‌ها')).toBe('CLEAN');
  });

  /**
   * Obfuscation, which is what the normalizer is for. The pipeline runs before
   * any rule is applied, so a term written with an Arabic yeh, a ZWNJ or a
   * repeated letter lands on the same tokens as the plain form.
   */
  it('sees through the cheap evasions', () => {
    // Arabic keh and yeh instead of Persian.
    expect(verdict('كازينو')).toBe('BLOCK');
    // A Latin character inserted mid-word, which the eye skips.
    expect(verdict('مشرrوب')).toBe('BLOCK');
    // Repetition.
    expect(verdict('شرااااب')).toBe('BLOCK');
  });
});

describe('the list itself', () => {
  it('normalizes to something the matcher can use', () => {
    for (const term of STARTER_BLACKLIST) {
      if (term.patternType === 'REGEX') continue;
      expect(normalize(term.termRaw).length, term.termRaw).toBeGreaterThan(0);
    }
  });

  /**
   * The pipeline folds the hamza and the alef, so a term stored in its display
   * form would match nothing. These two are the ones where the difference is
   * visible, and they are asserted so a future edit that stores the raw form
   * fails here rather than in production.
   */
  it('stores the folded form, not the typed one', () => {
    expect(normalize('هروئین')).toBe('هرویین');
    expect(normalize('آبجو')).toBe('ابجو');
  });

  it('gives every term a rationale for the next person to read', () => {
    for (const term of STARTER_BLACKLIST) {
      expect(term.rationale.length, term.termRaw).toBeGreaterThan(20);
    }
  });
});
