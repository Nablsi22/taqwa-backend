-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: scheduled_notifications
-- Date:      2026-10-25
--
-- Purpose
--   The evening notifications (Phase 4): the 9 pm «لم تسجّل» reminder to an
--   instructor (and to whoever claimed his حلقة that day), the «غاب جلستين
--   متتاليتين — اتصل واطمئن عليه» alert, and the 11 pm summary to the course
--   director. Each one is written here BEFORE its push is sent, under a
--   unique key, so a job that runs twice — a restart at 9 pm, a catch-up run,
--   two replicas — cannot send the same notification twice. The same rows
--   are the log an admin reads: what went out, to whom, and whether Firebase
--   accepted it.
--
-- Safety contract (runs against live production data)
--   • Creates ONE new table. No existing table, column, row or constraint
--     is read, altered or deleted.
--   • Idempotent: IF NOT EXISTS throughout, safe to re-run.
--   • Column types match what Prisma generates for the ScheduledNotification
--     model (String → TEXT, DateTime @db.Date → DATE, DateTime →
--     TIMESTAMP(3), Boolean → BOOLEAN), so `prisma migrate dev` finds no
--     drift.
--   • No foreign key: it is a log. A user who is deleted later simply stops
--     receiving anything; his old rows stay as history.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS "scheduled_notifications" (
  "id"         TEXT         NOT NULL,
  -- ATTENDANCE_REMINDER | ABSENCE_ALERT | DIRECTOR_SUMMARY
  "kind"       TEXT         NOT NULL,
  "user_id"    TEXT         NOT NULL,
  -- The day the notification is about, on the Damascus calendar.
  "day"        DATE         NOT NULL,
  -- Daily kinds carry the day in the key; the absence alert carries the
  -- streak («student:<id>:since:<last attended>»), so it is sent once per
  -- break, not once per evening.
  "ref_key"    TEXT         NOT NULL,
  "title"      TEXT         NOT NULL,
  "body"       TEXT         NOT NULL,
  "sent"       BOOLEAN      NOT NULL DEFAULT false,
  "error"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "scheduled_notifications_pkey" PRIMARY KEY ("id")
);

-- The dedup key. INSERT … ON CONFLICT DO NOTHING on it decides who sends.
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_notifications_kind_user_ref_key"
  ON "scheduled_notifications" ("kind", "user_id", "ref_key");

-- The admin log reads one day at a time.
CREATE INDEX IF NOT EXISTS "scheduled_notifications_day_idx"
  ON "scheduled_notifications" ("day");

COMMIT;
