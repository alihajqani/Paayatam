-- Migration 0059: marketing seed events (see
-- docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
--
-- `user.is_seed` marks a synthetic identity created only to occupy a seat on
-- a fake event; it never has a `telegram_account` row, so no code path can
-- resolve a chat id for it even if a future call site forgets to check the
-- flag. `event.is_seeded` marks the event itself, for admin filtering.
-- `city_seed_config` is the admin-tunable, per-city scheduler configuration;
-- absence of a row means the scheduler leaves that city alone. `host_user_id`
-- is `RESTRICT`, not `CASCADE`: deleting the host account while a config
-- still names it is a mistake the database should refuse, not quietly clean
-- up after.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_seed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "is_seeded" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "city_seed_config" (
  "city_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "floor_count" INTEGER NOT NULL DEFAULT 1,
  "event_capacity" INTEGER NOT NULL DEFAULT 6,
  "fill_minutes" INTEGER NOT NULL DEFAULT 5,
  "host_user_id" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_by_admin_id" TEXT NOT NULL,

  CONSTRAINT "city_seed_config_pkey" PRIMARY KEY ("city_id")
);

DO $$ BEGIN
  ALTER TABLE "city_seed_config"
    ADD CONSTRAINT "city_seed_config_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "city_seed_config"
    ADD CONSTRAINT "city_seed_config_host_user_id_fkey"
    FOREIGN KEY ("host_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "city_seed_config_host_user_id_idx" ON "city_seed_config" ("host_user_id");
