-- Migration 0037: the words that must not publish.
--
-- Data only. No column is added, dropped, renamed or narrowed. Idempotent: the
-- statement is an upsert on the table's own `UNIQUE (term_normalized,
-- pattern_type)`, so running it twice changes nothing the second time and the
-- version counter is bumped only when a row actually moved.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the list is in a migration and not only in the seed
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `blacklist_term` is *data*, and `tools/seed-blacklist.ts` is the file that
-- says what the starting list should be — but that script goes through
-- `openSeed`, which refuses to run against production without a flag, an
-- interactive terminal and a typed confirmation. That rail is right: a seed
-- writes user-visible content, and one that runs by accident is one that
-- publishes placeholder legal text.
--
-- It also means the deployed list is whatever it was on the day somebody last
-- typed the database name at a prompt. The first QA round found what that costs:
-- «شرابخواری» published, because the deployed list held «مشروب» and nothing
-- else, and «شراب» is a different string. A moderation list that only changes
-- when an operator remembers to change it is a moderation list that does not
-- change.
--
-- So the list ships with the release, through the migration the deploy already
-- runs. The seed keeps the same terms — they are the same list, and
-- `seed-blacklist.ts` carries the rationale for each one, which is what the next
-- person editing them needs.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What EXACT and SUBSTRING mean here, since choosing wrong is the whole risk
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EXACT matches a **whole token** of the normalized text; SUBSTRING matches
-- anywhere in it. Persian has the same trap English does — «بنگ» sits inside
-- «بنگاه», «سکس» sits inside «سکسکه» — so SUBSTRING is used only where the stem
-- cannot appear inside an innocent word, and where a compound is the point:
-- «شراب» has to be SUBSTRING or «شرابخواری» does not match it, which is exactly
-- the report this migration answers.
--
-- BLOCK does not publish; FLAG publishes and opens a case. ADR-0012 makes FLAG
-- the default for anything ambiguous, and that is unchanged. What changed is
-- «صیغه»: it was FLAG, so a listing advertising it went live and waited in a
-- queue. The word is a genuine religious and legal term — hence EXACT, so an
-- inflection in a discussion of family law is judged on its own — but an
-- *activity offering it to strangers* has one reading, and BLOCK is that reading.
--
-- The terms are stored **normalized**, by the same `normalize()` the scanner
-- runs over the text it matches. The values below were produced by that function
-- rather than typed: «هروئین» is stored as «هرویین» and «آبجو» as «ابجو»,
-- because the pipeline folds the hamza and the alef, and a term hand-typed in
-- its display form would silently match nothing.

INSERT INTO "blacklist_term" (
  "id",
  "term_raw",
  "term_normalized",
  "pattern_type",
  "severity",
  "category",
  "is_active",
  "created_by",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::TEXT,
  t."term_raw",
  t."term_normalized",
  t."pattern_type"::"blacklist_pattern_type",
  t."severity"::"blacklist_severity",
  t."category",
  TRUE,
  'migration-0037',
  NOW(),
  NOW()
FROM (VALUES
  ('مواد مخدر', 'مواد مخدر', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('هروئین', 'هرویین', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('کوکائین', 'کوکایین', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('حشیش', 'حشیش', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('ماریجوانا', 'ماریجوانا', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('تریاک', 'تریاک', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('قرص اکس', 'قرص اکس', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('شیشه', 'شیشه', 'EXACT', 'FLAG', 'drugs'),
  ('بنگ', 'بنگ', 'EXACT', 'FLAG', 'drugs'),
  ('گل کشیدن', 'گل کشیدن', 'SUBSTRING', 'BLOCK', 'drugs'),
  ('شرط‌بندی', 'شرط بندی', 'SUBSTRING', 'BLOCK', 'gambling'),
  ('قمار', 'قمار', 'EXACT', 'BLOCK', 'gambling'),
  ('کازینو', 'کازینو', 'SUBSTRING', 'BLOCK', 'gambling'),
  ('پوکر', 'پوکر', 'EXACT', 'BLOCK', 'gambling'),
  ('مشروب', 'مشروب', 'SUBSTRING', 'BLOCK', 'alcohol'),
  ('شراب', 'شراب', 'SUBSTRING', 'BLOCK', 'alcohol'),
  ('آبجو', 'ابجو', 'SUBSTRING', 'BLOCK', 'alcohol'),
  ('ودکا', 'ودکا', 'SUBSTRING', 'BLOCK', 'alcohol'),
  ('ویسکی', 'ویسکی', 'SUBSTRING', 'BLOCK', 'alcohol'),
  ('عرق سگی', 'عرق سگی', 'SUBSTRING', 'BLOCK', 'alcohol'),
  ('الکل', 'الکل', 'EXACT', 'FLAG', 'alcohol'),
  ('صیغه', 'صیغه', 'EXACT', 'BLOCK', 'solicitation'),
  ('ازدواج موقت', 'ازدواج موقت', 'SUBSTRING', 'BLOCK', 'solicitation'),
  ('سکس', 'سکس', 'EXACT', 'BLOCK', 'solicitation'),
  ('سکسی', 'سکسی', 'EXACT', 'BLOCK', 'solicitation'),
  ('رابطه جنسی', 'رابطه جنسی', 'SUBSTRING', 'BLOCK', 'solicitation'),
  ('تن فروشی', 'تن فروشی', 'SUBSTRING', 'BLOCK', 'solicitation'),
  ('پورن', 'پورن', 'SUBSTRING', 'BLOCK', 'solicitation'),
  ('دوست دختر', 'دوست دختر', 'SUBSTRING', 'FLAG', 'solicitation'),
  ('دوست پسر', 'دوست پسر', 'SUBSTRING', 'FLAG', 'solicitation'),
  ('اسلحه', 'اسلحه', 'SUBSTRING', 'BLOCK', 'weapons'),
  ('چاقوکشی', 'چاقوکشی', 'SUBSTRING', 'BLOCK', 'weapons'),
  ('(\+?98|0)9\d{9}', '(\+?98|0)9\d{9}', 'REGEX', 'FLAG', 'contact'),
  ('t.me/', 't.me/', 'SUBSTRING', 'FLAG', 'contact')
) AS t("term_raw", "term_normalized", "pattern_type", "severity", "category")
ON CONFLICT ("term_normalized", "pattern_type") DO UPDATE
SET
  -- The severity is the point of the upsert: «صیغه» exists as FLAG on every
  -- deployment and has to become BLOCK. `is_active` is restored too, because a
  -- term a moderator deactivated by mistake should come back with the release
  -- that says it belongs in the list.
  "severity" = EXCLUDED."severity",
  "category" = EXCLUDED."category",
  "is_active" = TRUE,
  "updated_at" = NOW()
WHERE
  "blacklist_term"."severity" IS DISTINCT FROM EXCLUDED."severity"
  OR "blacklist_term"."category" IS DISTINCT FROM EXCLUDED."category"
  OR "blacklist_term"."is_active" IS DISTINCT FROM TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- The version that judged
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every `moderation_case` records the `blacklist_version` that produced it, so a
-- decision taken six weeks ago can still be read against the list that took it.
-- A new version is therefore published whenever the list actually moves — and
-- **only** then, because inflating the counter on a no-op deploy would make
-- those references point at versions that changed nothing.
--
-- The list moves on this deploy on every deployment that exists — the terms
-- above are two dozen more than any of them carries — so the version is
-- published unconditionally, guarded only against being published twice. The
-- guard is the migration's own provenance rather than a row count: a rerun must
-- add no version, and `_prisma_migrations` already makes a rerun impossible, so
-- this is the belt to that pair of braces.

INSERT INTO "blacklist_version" ("id", "version", "note", "created_by", "created_at")
SELECT
  gen_random_uuid()::TEXT,
  COALESCE((SELECT MAX("version") FROM "blacklist_version"), 0) + 1,
  'migration 0037: alcohol, narcotics, gambling, solicitation and weapons widened; «صیغه» raised to BLOCK',
  'migration-0037',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "blacklist_version" WHERE "created_by" = 'migration-0037'
);
