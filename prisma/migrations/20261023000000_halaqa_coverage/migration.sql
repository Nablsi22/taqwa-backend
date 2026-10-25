-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: halaqa_coverage
-- Date:      2026-10-23
--
-- Purpose
--   «استلمت هالحلقة اليوم» — a substitute instructor saying, for one day,
--   that another حلقة is his responsibility. Recording attendance or
--   recitation for another حلقة's students already works and already stores
--   who marked it (attendance.marked_by), but the 9 pm reminder has to know
--   who covered BEFORE anything is recorded: without this table a covered
--   حلقة whose substitute has not marked anybody yet is indistinguishable
--   from a حلقة nobody is looking after, and the reminder would go to the
--   absent teacher alone.
--
--   One day can have several covering instructors for the same حلقة — an
--   absent teacher's students are sometimes split between two substitutes —
--   so the key is (حلقة, substitute, day), not (حلقة, day).
--
--   The students stay with their own instructor: nothing here reassigns a
--   student, and no statistic reads this table. It is a note about a day.
--
-- Safety contract (runs against live production data)
--   • Creates ONE new table. No existing table, column, row or constraint
--     is read, altered or deleted.
--   • Idempotent: IF NOT EXISTS throughout, safe to re-run.
--   • Column types match what Prisma generates for the HalaqaCoverage model
--     (String → TEXT, DateTime @db.Date → DATE, DateTime → TIMESTAMP(3)),
--     so `prisma migrate dev` finds no drift.
--   • ON DELETE CASCADE on both instructor references: deleting an
--     instructor can never be blocked by a leftover coverage note. The app
--     only deletes an instructor who has no students (instructors.remove).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS "halaqa_coverage" (
  "id"                     TEXT         NOT NULL,
  -- The حلقة being covered, i.e. the instructor the students belong to.
  "halaqa_instructor_id"   TEXT         NOT NULL,
  -- The substitute who took it for the day.
  "covering_instructor_id" TEXT         NOT NULL,
  "date"                   DATE         NOT NULL,
  "note"                   TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "halaqa_coverage_pkey" PRIMARY KEY ("id")
);

-- Claiming the same حلقة twice on the same day is the same fact, so the
-- endpoint upserts on this key instead of piling up rows.
CREATE UNIQUE INDEX IF NOT EXISTS "halaqa_coverage_halaqa_covering_date_key"
  ON "halaqa_coverage" ("halaqa_instructor_id", "covering_instructor_id", "date");

-- The 11 pm director summary and the 9 pm reminder both read by day.
CREATE INDEX IF NOT EXISTS "halaqa_coverage_date_idx"
  ON "halaqa_coverage" ("date");

-- "which حلقات did I cover" and "who covered this حلقة".
CREATE INDEX IF NOT EXISTS "halaqa_coverage_covering_instructor_id_idx"
  ON "halaqa_coverage" ("covering_instructor_id");
CREATE INDEX IF NOT EXISTS "halaqa_coverage_halaqa_instructor_id_date_idx"
  ON "halaqa_coverage" ("halaqa_instructor_id", "date");

-- Covering your own حلقة is not coverage; it would also make the reminder
-- count a present teacher as a substitute for himself.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'halaqa_coverage_not_self_chk'
  ) THEN
    ALTER TABLE "halaqa_coverage"
      ADD CONSTRAINT "halaqa_coverage_not_self_chk"
      CHECK ("halaqa_instructor_id" <> "covering_instructor_id");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'halaqa_coverage_halaqa_instructor_id_fkey'
  ) THEN
    ALTER TABLE "halaqa_coverage"
      ADD CONSTRAINT "halaqa_coverage_halaqa_instructor_id_fkey"
      FOREIGN KEY ("halaqa_instructor_id") REFERENCES "instructors"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'halaqa_coverage_covering_instructor_id_fkey'
  ) THEN
    ALTER TABLE "halaqa_coverage"
      ADD CONSTRAINT "halaqa_coverage_covering_instructor_id_fkey"
      FOREIGN KEY ("covering_instructor_id") REFERENCES "instructors"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
