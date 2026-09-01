import type { BlacklistPatternType, BlacklistSeverity } from '@payetam/db';

/**
 * The blacklist the product ships with (ADR-0012).
 *
 * ── Why the list is a module and not only a seed script ─────────────────────
 *
 * It had one consumer — `tools/seed-blacklist.ts` — and two things wanted it.
 * The matcher's tests wanted the *real* list, because a test over three invented
 * terms proves the regex engine works and proves nothing about whether
 * «شرابخواری» publishes; and migration 0037 wanted it, because a moderation list
 * that only reaches production when an operator types a database name at a
 * prompt is a moderation list that does not change. The first QA round found
 * exactly what that costs.
 *
 * So the terms live here, the seed writes them for a fresh database, migration
 * 0037 carries the same rows to every deployment, and `blacklist.match.test.ts`
 * asserts against them rather than against a fixture that can agree with nothing.
 *
 * ── Two things to understand before adding a term ───────────────────────────
 *
 *  - **EXACT matches a whole token; SUBSTRING matches anywhere.** Persian has
 *    the same trap English does — «بنگ» sits inside «بنگاه» and «سکس» sits
 *    inside «سکسکه». Use SUBSTRING only where the stem cannot appear inside an
 *    innocent word, and where a compound is the point: «شراب» has to be
 *    SUBSTRING or «شرابخواری» does not match it.
 *  - **FLAG publishes; BLOCK does not.** ADR-0012 makes FLAG the default for
 *    anything ambiguous, because a false positive that blocks a legitimate host
 *    is the worse outcome. Reach for BLOCK only where the term has no innocent
 *    reading *in an activity listing* — which is a narrower question than
 *    whether the word has one in Persian.
 *
 * The terms are written here in their display form. Everything that consumes
 * them runs `normalize()` first, so «هروئین» is matched as «هرویین» and «آبجو»
 * as «ابجو» — a term hand-normalized by eye would silently match nothing.
 */
export interface StarterTerm {
  termRaw: string;
  patternType: BlacklistPatternType;
  severity: BlacklistSeverity;
  category: string;
  /** Why this term, and why this severity. Read by the next person to edit the list. */
  rationale: string;
}

export const STARTER_BLACKLIST: readonly StarterTerm[] = [
  // ── Narcotics ─────────────────────────────────────────────────────────────
  {
    termRaw: 'مواد مخدر',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Narcotics, explicit. No innocent reading in an activity listing.',
  },
  {
    termRaw: 'هروئین',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Named narcotic. Nothing it can be a substring of.',
  },
  {
    termRaw: 'کوکائین',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Named narcotic. Nothing it can be a substring of.',
  },
  {
    termRaw: 'حشیش',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Named narcotic. Nothing it can be a substring of.',
  },
  {
    termRaw: 'ماریجوانا',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Named narcotic. Nothing it can be a substring of.',
  },
  {
    termRaw: 'تریاک',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Named narcotic. Nothing it can be a substring of.',
  },
  {
    termRaw: 'قرص اکس',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale:
      'Ecstasy. A phrase rather than «اکس» alone, which is also «ex» and a photograph.',
  },
  {
    termRaw: 'شیشه',
    patternType: 'EXACT',
    severity: 'FLAG',
    category: 'drugs',
    rationale:
      'Slang for methamphetamine — and the ordinary word for glass. «کافه شیشه‌ای» must not be blocked, so this goes to a human.',
  },
  {
    termRaw: 'بنگ',
    patternType: 'EXACT',
    severity: 'FLAG',
    category: 'drugs',
    rationale:
      'Drug slang, and a substring of «بنگاه». EXACT keeps estate agents out of the queue; FLAG keeps a false positive out of the host way.',
  },
  {
    termRaw: 'گل کشیدن',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale:
      'Smoking cannabis. The verb is what makes it unambiguous — «گل» alone is a flower, a goal and a common name.',
  },

  // ── Gambling ──────────────────────────────────────────────────────────────
  {
    termRaw: 'شرط‌بندی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'gambling',
    rationale: 'Betting. Unambiguous, and a common spam vector.',
  },
  {
    termRaw: 'قمار',
    patternType: 'EXACT',
    severity: 'BLOCK',
    category: 'gambling',
    rationale:
      'Gambling. EXACT rather than SUBSTRING so «قمارباز» in a novel-club description is judged on its own.',
  },
  {
    termRaw: 'کازینو',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'gambling',
    rationale: 'Casino. No lawful reading as a gathering here.',
  },
  {
    termRaw: 'پوکر',
    patternType: 'EXACT',
    severity: 'BLOCK',
    category: 'gambling',
    rationale:
      'Poker, which is gambling here whatever the stake. EXACT because the word is short and borrowed.',
  },

  // ── Alcohol ───────────────────────────────────────────────────────────────
  {
    termRaw: 'مشروب',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale: 'Alcohol, which is illegal to offer here. SUBSTRING covers «مشروبات».',
  },
  {
    /**
     * The word the first QA round found: «شرابخواری» published, because the list
     * held «مشروب» and nothing else. SUBSTRING is what makes the compound match —
     * «شرابخواری», «شراب‌خواری» and «شراب خوری» are one word to the normalizer
     * once the ZWNJ has become a space, and only the first two contain the stem
     * with no separator.
     */
    termRaw: 'شراب',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale:
      'Wine, and the stem of every compound naming drinking it. No innocent reading in an activity listing.',
  },
  {
    termRaw: 'آبجو',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale: 'Beer. Folded to «ابجو» by the normalizer, which is also how a host would type it.',
  },
  {
    termRaw: 'ودکا',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale: 'Vodka. Borrowed word with no other reading.',
  },
  {
    termRaw: 'ویسکی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale: 'Whisky. Borrowed word with no other reading.',
  },
  {
    termRaw: 'عرق سگی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale:
      'Home-distilled spirit. The phrase, not «عرق» — which is sweat, and a herbal distillate sold in every grocery.',
  },
  {
    termRaw: 'الکل',
    patternType: 'EXACT',
    severity: 'FLAG',
    category: 'alcohol',
    rationale:
      'Alcohol as a substance — and the word on a bottle of hand sanitiser in a hiking kit list. Human judgement.',
  },

  // ── Solicitation ──────────────────────────────────────────────────────────
  {
    /**
     * Promoted from FLAG in the first QA round. FLAG *publishes* — that is
     * ADR-0012's central tuning decision and it is right for an ambiguous term —
     * and the report was precisely that a listing whose description said «صیغه»
     * went live and sat in a queue nobody had worked yet.
     *
     * The ambiguity argument does not survive the setting: the word is a genuine
     * religious and legal term, and *an activity advertising it to strangers* has
     * one reading. EXACT keeps it a whole word, so a discussion of family law
     * that happens to inflect it is still judged on its own.
     */
    termRaw: 'صیغه',
    patternType: 'EXACT',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale:
      'Routinely used to advertise solicitation. A legitimate legal term, so EXACT rather than SUBSTRING — but an activity offering it has no innocent reading.',
  },
  {
    termRaw: 'ازدواج موقت',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale: 'The other name for the same offer, and the one that evades the term above.',
  },
  {
    termRaw: 'سکس',
    patternType: 'EXACT',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale:
      'EXACT rather than SUBSTRING because «سکسکه» — hiccup — contains it. The ZWNJ is already a space by the time this matches, so «سکس‌چت» is two tokens and the first of them is this one.',
  },
  {
    termRaw: 'سکسی',
    patternType: 'EXACT',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale: 'The inflection EXACT on the stem cannot reach, and the one a listing actually uses.',
  },
  {
    termRaw: 'رابطه جنسی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale: 'The phrase, not «جنسی» — which appears in «تفکیک جنسیتی» and in ordinary prose.',
  },
  {
    termRaw: 'تن فروشی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale: 'Prostitution, explicit.',
  },
  {
    termRaw: 'پورن',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'solicitation',
    rationale: 'Pornography. Borrowed word with no other reading.',
  },
  {
    termRaw: 'دوست دختر',
    patternType: 'SUBSTRING',
    severity: 'FLAG',
    category: 'solicitation',
    rationale:
      'The staple of a dating-solicitation listing, and something two friends might write about a film. Human judgement.',
  },
  {
    termRaw: 'دوست پسر',
    patternType: 'SUBSTRING',
    severity: 'FLAG',
    category: 'solicitation',
    rationale: 'As «دوست دختر», and it must not be the one of the pair that is unchecked.',
  },

  // ── Weapons ───────────────────────────────────────────────────────────────
  {
    termRaw: 'اسلحه',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'weapons',
    rationale: 'A firearm at a gathering of strangers. No lawful reading here.',
  },
  {
    termRaw: 'چاقوکشی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'weapons',
    rationale: 'Knife violence. Folded to «چاقوکشی» whether or not the host used a ZWNJ.',
  },

  // ── Routing around the anonymous chat ─────────────────────────────────────
  {
    // Normalization has already turned Persian digits into Latin ones by the time
    // this runs, so the pattern only needs to know about 0-9.
    termRaw: '(\\+?98|0)9\\d{9}',
    patternType: 'REGEX',
    severity: 'FLAG',
    category: 'contact',
    rationale:
      "An Iranian mobile number in a public listing routes people around the anonymous chat, which is the product's whole safety model. Flagged, not blocked: a venue phone number is a plausible mistake, not an attack.",
  },
  {
    termRaw: 't.me/',
    patternType: 'SUBSTRING',
    severity: 'FLAG',
    category: 'contact',
    rationale:
      'A Telegram link in a description is the same evasion a phone number is — and is also how a host shares their own channel, which is legitimate. The link field is the right place for it; a human decides.',
  },
];
