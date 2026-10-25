-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: attendance_foundation
-- Date:      2026-10-22
--
-- Purpose
--   1. Meeting days live on the course (term) itself, as REQUIRED and
--      OPTIONAL ISO weekdays (Monday = 1 … Sunday = 7, as EXTRACT(ISODOW)):
--        winter-2026-2027  required {6} Saturday · optional {4} Thursday
--        summer-2026       required {6,1,3} Saturday, Monday, Wednesday
--      An optional day (and any day outside the schedule) only ever counts in
--      a student's favour: absence on it is never a miss and never deducted.
--   2. A حلقة can be flagged as a holding pool for frozen students («عزل»):
--      its students are left out of every statistic and every reminder.
--   3. «غائب بعذر»: an ABSENT record can be marked excused — no deduction,
--      no "call the family" alert, not a miss for the regular-student count.
--
-- Safety contract (runs against live production data)
--   • NOTHING IS DELETED, no existing value is overwritten, no points row is
--     touched. Every statement only ADDS a column, a constraint, or fills a
--     brand-new column on a row where that column is still at its default.
--   • ADD COLUMN with a constant DEFAULT is a catalog-only change in
--     PostgreSQL 11+: no table rewrite, no long lock.
--       https://www.postgresql.org/docs/current/sql-altertable.html#SQL-ALTERTABLE-NOTES
--   • Idempotent: safe to re-run; every step checks before it acts.
--   • Column types match what Prisma generates for the new schema fields
--     (Int[] → INTEGER[], Boolean → BOOLEAN), so there is no schema drift.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Meeting days on the course
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "terms" ADD COLUMN IF NOT EXISTS "required_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "terms" ADD COLUMN IF NOT EXISTS "optional_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'terms_meeting_days_chk') THEN
    ALTER TABLE "terms"
      ADD CONSTRAINT "terms_meeting_days_chk"
      CHECK (
            "required_days" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
        AND "optional_days" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
        AND NOT ("required_days" && "optional_days")
      );
  END IF;
END $$;

-- Known courses, filled only while BOTH columns are still empty — a value an
-- admin has set is never overwritten, and a re-run changes nothing.
UPDATE "terms"
   SET "required_days" = ARRAY[6], "optional_days" = ARRAY[4]
 WHERE "name" = 'winter-2026-2027'
   AND "required_days" = ARRAY[]::INTEGER[] AND "optional_days" = ARRAY[]::INTEGER[];

UPDATE "terms"
   SET "required_days" = ARRAY[6, 1, 3]
 WHERE "name" = 'summer-2026'
   AND "required_days" = ARRAY[]::INTEGER[] AND "optional_days" = ARRAY[]::INTEGER[];

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Holding pool («عزل»)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "instructors" ADD COLUMN IF NOT EXISTS "is_holding_pool" BOOLEAN NOT NULL DEFAULT false;

UPDATE "instructors"
   SET "is_holding_pool" = true
 WHERE btrim("full_name") = 'عزل'
   AND "is_holding_pool" = false;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Excused absence («غائب بعذر»)
--    The status stays ABSENT, so app versions that know nothing of `excused`
--    keep reading the record exactly as before.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "excused" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_excused_only_absent_chk') THEN
    -- Every existing row has excused = false, so validating it is instant.
    ALTER TABLE "attendance"
      ADD CONSTRAINT "attendance_excused_only_absent_chk"
      CHECK (NOT "excused" OR "status" = 'ABSENT');
  END IF;
END $$;

COMMIT;
