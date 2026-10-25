-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: course_isolation_and_verse_range
-- Date:      2026-09-05
--
-- Purpose
--   1. Close the last gaps in course (term) isolation:
--        • no recitation / points row may exist without a course
--        • a row's course can never change after insert — points can never
--          migrate from one course to another
--   2. Make the verse range the only accepted shape for a new recitation:
--        start_surah + start_aya + end_aya, with the range validated in the
--        database, not only in the UI.
--
-- Safety contract (explicit, because this runs against live production data)
--   • NOTHING IS DELETED. No student, no recitation, no points row.
--   • NO EXISTING POINTS AMOUNT IS CHANGED. Historical scores are frozen
--     exactly as they were awarded.
--   • Every value this migration overwrites is snapshotted first into
--     `term_backfill_audit`, so the backfill is fully reversible.
--   • The new CHECK constraints are ADDed as NOT VALID and are additionally
--     scoped to rows created from the cutoff onwards, so historical rows are
--     grandfathered and can still be read AND updated.
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Rows created strictly before this instant are historical and exempt from
-- the new shape rules. Rows created from here on must satisfy them.
-- Kept as a literal (not now()) so the constraint means the same thing on
-- every environment and on every future re-validation.
-- ── CUTOFF = 2026-09-05T00:00:00 ──

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Preconditions
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM terms) THEN
    RAISE EXCEPTION
      'No rows in "terms". Run prisma/seed-terms.ts before this migration.';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Reversibility ledger
--
--    Every column value this migration writes over is recorded here first.
--    Restoring is a single UPDATE ... FROM against this table.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "term_backfill_audit" (
  "id"          BIGSERIAL    PRIMARY KEY,
  "migration"   TEXT         NOT NULL,
  "table_name"  TEXT         NOT NULL,
  "row_id"      TEXT         NOT NULL,
  "column_name" TEXT         NOT NULL,
  "old_value"   TEXT,
  "new_value"   TEXT,
  "captured_at" TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "term_backfill_audit_lookup_idx"
  ON "term_backfill_audit" ("migration", "table_name", "row_id");

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Backfill orphaned term_id
--
--    Resolution order, most reliable first:
--      a. the course whose date window contains the recitation's date
--      b. points_log rows produced by a recitation inherit that recitation's
--         course, so a session's recitation and its points never split
--      c. otherwise, the course whose date window contains the row's date
--      d. otherwise (rows predating every course), the earliest course
--
--    Only rows where term_id IS NULL are touched.
-- ─────────────────────────────────────────────────────────────────────────

-- 2a. recitations → by recitation date (done first so points_log can inherit)
INSERT INTO "term_backfill_audit"
  ("migration", "table_name", "row_id", "column_name", "old_value", "new_value")
SELECT
  'course_isolation_and_verse_range', 'recitations', r.id, 'term_id',
  NULL,
  COALESCE(
    (SELECT t.id FROM terms t
      WHERE r.date >= t.start_date
        AND (t.end_date IS NULL OR r.date <= t.end_date)
      ORDER BY t.start_date DESC, t.id DESC LIMIT 1),
    (SELECT t.id FROM terms t ORDER BY t.start_date ASC, t.id ASC LIMIT 1)
  )::text
FROM "recitations" r
WHERE r.term_id IS NULL;

UPDATE "recitations" r
SET "term_id" = COALESCE(
  (SELECT t.id FROM terms t
    WHERE r.date >= t.start_date
      AND (t.end_date IS NULL OR r.date <= t.end_date)
    ORDER BY t.start_date DESC, t.id DESC LIMIT 1),
  (SELECT t.id FROM terms t ORDER BY t.start_date ASC, t.id ASC LIMIT 1)
)
WHERE r.term_id IS NULL;

-- 2b. points_log → inherit from the source recitation, so a session's
--     recitation and the points it produced can never land in two courses
INSERT INTO "term_backfill_audit"
  ("migration", "table_name", "row_id", "column_name", "old_value", "new_value")
SELECT
  'course_isolation_and_verse_range', 'points_log', pl.id, 'term_id',
  NULL, r.term_id::text
FROM "points_log" pl
JOIN "recitations" r ON r.id = pl.source_id
WHERE pl.term_id IS NULL
  AND pl.source_type = 'RECITATION'
  AND r.term_id IS NOT NULL;

UPDATE "points_log" pl
SET "term_id" = r."term_id"
FROM "recitations" r
WHERE r.id = pl.source_id
  AND pl.term_id IS NULL
  AND pl.source_type = 'RECITATION'
  AND r.term_id IS NOT NULL;

-- 2c. points_log → by creation date (rows not sourced from a recitation)
INSERT INTO "term_backfill_audit"
  ("migration", "table_name", "row_id", "column_name", "old_value", "new_value")
SELECT
  'course_isolation_and_verse_range', 'points_log', pl.id, 'term_id',
  NULL,
  COALESCE(
    (SELECT t.id FROM terms t
      WHERE pl.created_at::date >= t.start_date
        AND (t.end_date IS NULL OR pl.created_at::date <= t.end_date)
      ORDER BY t.start_date DESC, t.id DESC LIMIT 1),
    (SELECT t.id FROM terms t ORDER BY t.start_date ASC, t.id ASC LIMIT 1)
  )::text
FROM "points_log" pl
WHERE pl.term_id IS NULL;

UPDATE "points_log" pl
SET "term_id" = COALESCE(
  (SELECT t.id FROM terms t
    WHERE pl.created_at::date >= t.start_date
      AND (t.end_date IS NULL OR pl.created_at::date <= t.end_date)
    ORDER BY t.start_date DESC, t.id DESC LIMIT 1),
  (SELECT t.id FROM terms t ORDER BY t.start_date ASC, t.id ASC LIMIT 1)
)
WHERE pl.term_id IS NULL;

-- 2d. hadith_recitations → by creation date
INSERT INTO "term_backfill_audit"
  ("migration", "table_name", "row_id", "column_name", "old_value", "new_value")
SELECT
  'course_isolation_and_verse_range', 'hadith_recitations', h.id, 'term_id',
  NULL,
  COALESCE(
    (SELECT t.id FROM terms t
      WHERE h.created_at::date >= t.start_date
        AND (t.end_date IS NULL OR h.created_at::date <= t.end_date)
      ORDER BY t.start_date DESC, t.id DESC LIMIT 1),
    (SELECT t.id FROM terms t ORDER BY t.start_date ASC, t.id ASC LIMIT 1)
  )::text
FROM "hadith_recitations" h
WHERE h.term_id IS NULL;

UPDATE "hadith_recitations" h
SET "term_id" = COALESCE(
  (SELECT t.id FROM terms t
    WHERE h.created_at::date >= t.start_date
      AND (t.end_date IS NULL OR h.created_at::date <= t.end_date)
    ORDER BY t.start_date DESC, t.id DESC LIMIT 1),
  (SELECT t.id FROM terms t ORDER BY t.start_date ASC, t.id ASC LIMIT 1)
)
WHERE h.term_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. term_id is immutable
--
--    "نقاط دورة لا تنتقل إلى دورة أخرى" enforced in the database rather than
--    trusted to application code. An UPDATE that would move a row from one
--    course to another is rejected. Filling a NULL term_id (the backfill
--    above, or a repair) stays allowed.
--    Ref: https://www.postgresql.org/docs/current/plpgsql-trigger.html
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION freeze_term_id()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.term_id IS NOT NULL AND NEW.term_id IS DISTINCT FROM OLD.term_id THEN
    RAISE EXCEPTION
      'term_id is immutable (row %): points cannot move between courses',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "recitations_freeze_term_id" ON "recitations";
CREATE TRIGGER "recitations_freeze_term_id"
  BEFORE UPDATE ON "recitations"
  FOR EACH ROW EXECUTE FUNCTION freeze_term_id();

DROP TRIGGER IF EXISTS "points_log_freeze_term_id" ON "points_log";
CREATE TRIGGER "points_log_freeze_term_id"
  BEFORE UPDATE ON "points_log"
  FOR EACH ROW EXECUTE FUNCTION freeze_term_id();

DROP TRIGGER IF EXISTS "hadith_recitations_freeze_term_id" ON "hadith_recitations";
CREATE TRIGGER "hadith_recitations_freeze_term_id"
  BEFORE UPDATE ON "hadith_recitations"
  FOR EACH ROW EXECUTE FUNCTION freeze_term_id();

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Every NEW row belongs to a course
--
--    NOT VALID → existing rows are never re-checked at ADD time.
--    The created_at guard → historical rows stay updatable forever, while
--    every row written from the cutoff onwards must carry a course.
--    Ref: https://www.postgresql.org/docs/current/sql-altertable.html
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recitations_term_required_chk'
  ) THEN
    ALTER TABLE "recitations"
      ADD CONSTRAINT "recitations_term_required_chk"
      CHECK (
        "created_at" < TIMESTAMP '2026-09-05 00:00:00'
        OR "term_id" IS NOT NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'points_log_term_required_chk'
  ) THEN
    ALTER TABLE "points_log"
      ADD CONSTRAINT "points_log_term_required_chk"
      CHECK (
        "created_at" < TIMESTAMP '2026-09-05 00:00:00'
        OR "term_id" IS NOT NULL
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hadith_recitations_term_required_chk'
  ) THEN
    ALTER TABLE "hadith_recitations"
      ADD CONSTRAINT "hadith_recitations_term_required_chk"
      CHECK (
        "created_at" < TIMESTAMP '2026-09-05 00:00:00'
        OR "term_id" IS NOT NULL
      ) NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Every NEW recitation carries a valid single-surah verse range
--
--    surah + start_aya + end_aya, with 1 <= start_aya <= end_aya. The upper
--    bound (end_aya <= the surah's ayah count) needs the Quran metadata and
--    is enforced in the service layer by validateRange().
--
--    MAQRAA rows are exempt: a مقرأة is a group-reading marker for parents,
--    carries no points and no memorized range.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'recitations_verse_range_chk'
  ) THEN
    ALTER TABLE "recitations"
      ADD CONSTRAINT "recitations_verse_range_chk"
      CHECK (
        "created_at" < TIMESTAMP '2026-09-05 00:00:00'
        OR "rating" = 'MAQRAA'
        OR (
              "startSurah" IS NOT NULL
          AND "endSurah"   IS NOT NULL
          AND "startAya"   IS NOT NULL
          AND "endAya"     IS NOT NULL
          AND "startSurah" BETWEEN 1 AND 114
          AND "endSurah"   = "startSurah"
          AND "startAya"   >= 1
          AND "endAya"     >= "startAya"
        )
      ) NOT VALID;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Reporting indexes — leaderboards and per-course stats read
--    (term_id, student_id) constantly; points_log_student_id_term_id_idx
--    already covers the student-first shape, these cover the course-first
--    aggregate.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "points_log_term_student_idx"
  ON "points_log" ("term_id", "student_id");

CREATE INDEX IF NOT EXISTS "recitations_term_student_idx"
  ON "recitations" ("term_id", "student_id");

COMMIT;
