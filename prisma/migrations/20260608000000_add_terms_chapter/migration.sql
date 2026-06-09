-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: add_terms_chapter
-- Date:      2026-06-08
-- Purpose:   Introduce Term entity to separate Winter/Summer chapters.
-- Strategy:  Additive-only DDL + BEFORE INSERT triggers to auto-tag new rows
--            with the currently-active term, so no application-code changes
--            are required for any service that writes to recitations or
--            points_log. Existing rows are backfilled by prisma/seed-terms.ts.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Create `terms` table
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "terms" (
  "id"         SERIAL       PRIMARY KEY,
  "name"       TEXT         NOT NULL UNIQUE,
  "name_ar"    TEXT         NOT NULL,
  "start_date" DATE         NOT NULL,
  "end_date"   DATE,
  "is_active"  BOOLEAN      NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "terms_is_active_idx" ON "terms" ("is_active");

-- At most ONE active term at any time. Enforced at DB layer.
-- Ref: https://www.postgresql.org/docs/current/indexes-partial.html
CREATE UNIQUE INDEX "terms_only_one_active_idx"
  ON "terms" ("is_active")
  WHERE "is_active" = true;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Add `term_id` to `recitations`
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "recitations" ADD COLUMN "term_id" INTEGER;
ALTER TABLE "recitations"
  ADD CONSTRAINT "recitations_term_id_fkey"
  FOREIGN KEY ("term_id") REFERENCES "terms"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "recitations_term_id_idx" ON "recitations" ("term_id");

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Add `term_id` to `points_log`
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "points_log" ADD COLUMN "term_id" INTEGER;
ALTER TABLE "points_log"
  ADD CONSTRAINT "points_log_term_id_fkey"
  FOREIGN KEY ("term_id") REFERENCES "terms"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "points_log_term_id_idx" ON "points_log" ("term_id");
CREATE INDEX "points_log_student_id_term_id_idx"
  ON "points_log" ("student_id", "term_id");

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Auto-tagging trigger: every INSERT into recitations or points_log that
--    leaves `term_id` NULL gets stamped with the currently-active term.
--    Ref: https://www.postgresql.org/docs/current/plpgsql-trigger.html
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_term_id_to_active()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.term_id IS NULL THEN
    SELECT id INTO NEW.term_id
      FROM terms
     WHERE is_active = true
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recitations_set_term_id
  BEFORE INSERT ON "recitations"
  FOR EACH ROW
  EXECUTE FUNCTION set_term_id_to_active();

CREATE TRIGGER points_log_set_term_id
  BEFORE INSERT ON "points_log"
  FOR EACH ROW
  EXECUTE FUNCTION set_term_id_to_active();

COMMIT;