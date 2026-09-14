-- Migration 0054: the settlement window really is eighteen hours (plan 15).
--
-- ── Why a default was not enough ────────────────────────────────────────────
--
-- Plan 15 moved `SETTLE_ATTENDANCE` from 03:00 Tehran to every hour and raised
-- `participation.settlement_delay_hours` in `SETTING_DEFAULTS` from 2 to 18. A
-- default only applies to a key with **no row**, and `seed-settings` writes
-- every key create-only — so a seeded deployment still holds 2. Hourly
-- settlement with 2 is a two-hour window to report a no-show: shorter than the
-- nightly run ever gave, and the opposite of what the plan decided. The
-- operator asked for the stored value to be 18 wherever the product runs, not
-- only where nobody ever wrote one.
--
-- ── What this does ──────────────────────────────────────────────────────────
--
-- 1. An audit row, the one the panel writes for the same change
--    (`setting.changed`, `target_type = 'app_setting'`, the key as target),
--    with the value it replaces. `actor_type = 'SYSTEM'`: no person pressed
--    save, a release did. Only when the stored value is not already 18, so a
--    re-run or an operator who got there first leaves no false entry. A missing
--    row records the old code default, 2, because that is what was in force.
-- 2. The row itself, upserted to 18, `version` bumped and `updated_by` cleared
--    on an actual change.
--
-- ── Rollback ────────────────────────────────────────────────────────────────
--
-- `scripts/rollback.sh` does not undo migrations. v0.13.0's code with 18 stored
-- settles at 03:00 whatever has ended 18 hours before — a window of 18 to 42
-- hours, never shorter than it was. Setting it back is one save in the panel.
INSERT INTO "audit_log" (
  "id", "actor_type", "action", "target_type", "target_id", "before", "after", "created_at"
)
SELECT
  gen_random_uuid()::TEXT,
  'SYSTEM',
  'setting.changed',
  'app_setting',
  'participation.settlement_delay_hours',
  jsonb_build_object(
    'value',
    COALESCE(
      (SELECT "value" FROM "app_setting" WHERE "key" = 'participation.settlement_delay_hours'),
      '2'::jsonb
    )
  ),
  jsonb_build_object(
    'value', 18,
    'reason', 'migration 0054 (plan 15): settlement runs hourly, the window is 18 hours'
  ),
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM "app_setting"
  WHERE "key" = 'participation.settlement_delay_hours' AND "value" = '18'::jsonb
);

INSERT INTO "app_setting" ("key", "value", "version", "created_at", "updated_at")
VALUES ('participation.settlement_delay_hours', '18'::jsonb, 1, now(), now())
ON CONFLICT ("key") DO UPDATE
  SET "value" = EXCLUDED."value",
      "version" = "app_setting"."version" + 1,
      "updated_by" = NULL,
      "updated_at" = now()
  WHERE "app_setting"."value" IS DISTINCT FROM EXCLUDED."value";
