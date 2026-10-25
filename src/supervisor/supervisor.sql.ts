/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Read-only SQL behind the course director's view of recording discipline.
 *
 * The question it answers: for every حلقة, on every meeting day of the
 * course, was the attendance recorded — and how long after the session.
 *
 * Where "how long after" comes from: `attendance.created_at` is written once,
 * when the first mark of that day is saved, and the mark route's upsert never
 * touches it again. So a correction made a week later does not move it, and
 * the lag is the real first-recording delay. The column has existed since the
 * first migration, so this reads true history from the start of the course.
 *
 * Same conventions as attendance-stats.sql.ts, which this sits beside: every
 * parameter is bound as a string (or null) and cast in SQL, every value comes
 * back cast to a driver-neutral type (counts → int, dates and timestamps →
 * text). Nothing here writes.
 *
 * References
 *   DISTINCT ON   https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT
 *   AT TIME ZONE  https://www.postgresql.org/docs/current/functions-datetime.html
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * One row per (حلقة × meeting day): whether it was recorded, when, by whom.
 *
 * Holding-pool («عزل») حلقات and حلقات with no students are left out — there
 * is nothing to record for them, so counting them as "did not record" would
 * be false.
 *
 *   $1 first day of the range (date)   $2 last day of the range (date)
 *   $3 the days to report, date[] literal '{2026-09-26,2026-10-03}'
 *   $4 local time zone                 $5 stored time zone
 */
export const RECORDING_DISCIPLINE_SQL = `
WITH
inst AS (
  SELECT i.id, i.full_name,
         count(s.id)::int AS students
  FROM instructors i
  JOIN students s ON s.instructor_id = i.id AND s.deleted_at IS NULL
  WHERE NOT i.is_holding_pool
  GROUP BY i.id, i.full_name
),
days AS (
  SELECT unnest($3::date[]) AS date
),
-- The first mark saved for that حلقة on that day, and who saved it. The lag
-- is measured from this one, not from a later correction.
first_mark AS (
  SELECT DISTINCT ON (s.instructor_id, a.date)
         s.instructor_id, a.date, a.created_at, a.marked_by
  FROM attendance a
  JOIN students s ON s.id = a.student_id
  WHERE a.date BETWEEN $1::date AND $2::date
  ORDER BY s.instructor_id, a.date, a.created_at ASC, a.id ASC
),
-- How much of the حلقة was marked that day, and whether anybody other than
-- its own أستاذ did it (a substitute, or an admin).
day_marks AS (
  SELECT s.instructor_id, a.date,
         count(*)::int AS marks,
         bool_or(m.id IS DISTINCT FROM s.instructor_id) AS by_other
  FROM attendance a
  JOIN students s ON s.id = a.student_id
  LEFT JOIN instructors m ON m.user_id = a.marked_by
  WHERE a.date BETWEEN $1::date AND $2::date
  GROUP BY s.instructor_id, a.date
)
SELECT
  i.id                                   AS instructor_id,
  i.full_name                            AS instructor_name,
  i.students                             AS students,
  d.date::text                           AS date,
  (fm.created_at IS NOT NULL)            AS recorded,
  CASE WHEN fm.created_at IS NULL THEN NULL ELSE
    to_char(
      ((fm.created_at AT TIME ZONE $5::text) AT TIME ZONE $4::text),
      'YYYY-MM-DD"T"HH24:MI'
    )
  END                                    AS recorded_at,
  CASE WHEN fm.created_at IS NULL THEN NULL ELSE
    (((fm.created_at AT TIME ZONE $5::text) AT TIME ZONE $4::text)::date - d.date)::int
  END                                    AS lag_days,
  COALESCE(mi.full_name, mu.username)    AS marked_by_name,
  COALESCE(dm.by_other, false)           AS by_other,
  COALESCE(dm.marks, 0)::int             AS marks
FROM inst i
CROSS JOIN days d
LEFT JOIN first_mark fm ON fm.instructor_id = i.id AND fm.date = d.date
LEFT JOIN day_marks  dm ON dm.instructor_id = i.id AND dm.date = d.date
LEFT JOIN users       mu ON mu.id = fm.marked_by
LEFT JOIN instructors mi ON mi.user_id = fm.marked_by
ORDER BY i.full_name ASC, d.date ASC
`;

export interface DisciplineRow {
  instructor_id: string;
  instructor_name: string;
  students: number;
  date: string;
  recorded: boolean;
  /** Local (Damascus) 'YYYY-MM-DDTHH:MM' of the first mark, or null. */
  recorded_at: string | null;
  /** 0 = recorded on the session day itself, 1 = next day, … */
  lag_days: number | null;
  marked_by_name: string | null;
  by_other: boolean;
  marks: number;
}
