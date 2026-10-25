/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Read-only SQL behind the attendance statistics.
 *
 * Contract shared with scripts/preflight-attendance-features.ts, where the
 * same logic was first run against production: every parameter is bound as a
 * string (or null) and cast in SQL, and every value comes back cast to a
 * driver-neutral type (counts → int, dates → text). Nothing here writes.
 *
 * References
 *   ISODOW / AT TIME ZONE  https://www.postgresql.org/docs/current/functions-datetime.html
 *   FILTER clause          https://www.postgresql.org/docs/current/sql-expressions.html#SYNTAX-AGGREGATES
 *   Window functions       https://www.postgresql.org/docs/current/tutorial-window.html
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * One row per current student (holding pool excluded) with their counts in
 * one course.
 *
 *   $1 course start (date)          $2 last day to read: min(course end, today)
 *   $3 window start (date)          $4 REQUIRED weekdays, int[] literal '{6}'
 *   $5 instructor id or NULL        $6 local time zone   $7 stored time zone
 *   $8 student id or NULL
 */
export const STUDENT_SUMMARY_SQL = `
WITH
st AS (
  SELECT s.id, s.full_name, s.father_name, s.instructor_id, i.full_name AS instructor_name,
         s.school, s.grade,
         GREATEST(
           $1::date,
           ((s.created_at AT TIME ZONE $7::text) AT TIME ZONE $6::text)::date
         ) AS joined
  FROM students s
  JOIN instructors i ON i.id = s.instructor_id
  WHERE s.deleted_at IS NULL
    AND NOT i.is_holding_pool
    AND ($5::text IS NULL OR s.instructor_id = $5::text)
    AND ($8::text IS NULL OR s.id = $8::text)
),
-- A session of a حلقة: any date on which one of its students has a record.
sessions AS (
  SELECT DISTINCT s.instructor_id, a.date
  FROM attendance a
  JOIN students s ON s.id = a.student_id
  WHERE a.date BETWEEN $1::date AND $2::date
    AND s.instructor_id IN (SELECT DISTINCT instructor_id FROM st)
),
-- Only a REQUIRED day can be missed. An optional or make-up day is kept only
-- for the students who attended it.
grid AS (
  SELECT st.id, se.date, a.status::text AS status, COALESCE(a.excused, false) AS excused
  FROM st
  JOIN sessions se ON se.instructor_id = st.instructor_id AND se.date >= st.joined
  LEFT JOIN attendance a ON a.student_id = st.id AND a.date = se.date
  WHERE EXTRACT(ISODOW FROM se.date)::int = ANY ($4::int[])
     OR a.status IN ('PRESENT', 'LATE')
),
ranked AS (
  SELECT g.*, row_number() OVER (PARTITION BY g.id ORDER BY g.date DESC) AS rn
  FROM grid g
),
agg AS (
  SELECT r.id,
    count(*) FILTER (WHERE NOT r.excused)::int                          AS sessions,
    count(*) FILTER (WHERE r.status = 'PRESENT')::int                   AS present,
    count(*) FILTER (WHERE r.status = 'LATE')::int                      AS late,
    count(*) FILTER (WHERE r.status = 'ABSENT' AND NOT r.excused)::int  AS absent,
    count(*) FILTER (WHERE r.excused)::int                              AS excused,
    count(*) FILTER (WHERE r.status IS NULL)::int                       AS unmarked,
    count(*) FILTER (WHERE r.date >= $3::date AND NOT r.excused)::int   AS win_sessions,
    count(*) FILTER (
      WHERE r.date >= $3::date AND r.status IN ('PRESENT', 'LATE')
    )::int                                                              AS win_attended,
    -- Unexcused ABSENT records counted from the latest session backwards.
    -- Anything else — attended, excused, or unmarked — ends the streak: we
    -- never alert on an unknown, and an excuse means the family is in touch.
    COALESCE(
      min(r.rn) FILTER (WHERE r.status IS DISTINCT FROM 'ABSENT' OR r.excused) - 1,
      max(r.rn)
    )::int                                                              AS absent_streak,
    (max(r.date) FILTER (WHERE r.status IN ('PRESENT', 'LATE')))::text  AS last_attended,
    (max(r.date))::text                                                 AS last_session
  FROM ranked r
  GROUP BY r.id
)
SELECT st.id::text                        AS student_id,
       st.full_name,
       st.father_name,
       st.instructor_id::text            AS instructor_id,
       st.instructor_name,
       st.school,
       st.grade,
       st.joined::text                   AS joined,
       COALESCE(a.sessions, 0)::int      AS sessions,
       COALESCE(a.present, 0)::int       AS present,
       COALESCE(a.late, 0)::int          AS late,
       COALESCE(a.absent, 0)::int        AS absent,
       COALESCE(a.excused, 0)::int       AS excused,
       COALESCE(a.unmarked, 0)::int      AS unmarked,
       COALESCE(a.win_sessions, 0)::int  AS win_sessions,
       COALESCE(a.win_attended, 0)::int  AS win_attended,
       COALESCE(a.absent_streak, 0)::int AS absent_streak,
       a.last_attended,
       a.last_session
FROM st
LEFT JOIN agg a ON a.id = st.id
ORDER BY st.instructor_name, st.full_name`;

/**
 * One row per student expected on one day, with what was recorded for them.
 * Holding pool excluded; students who joined after the day excluded; a
 * student deleted since is kept only if they were recorded that day.
 *
 *   $1 day   $2 instructor id or NULL   $3 local time zone   $4 stored time zone
 */
export const DAY_ROSTER_SQL = `
SELECT s.id::text          AS student_id,
       s.full_name,
       s.father_name,
       i.id::text          AS instructor_id,
       i.full_name         AS instructor_name,
       a.status::text      AS status,
       COALESCE(a.excused, false) AS excused,
       (a.id IS NOT NULL AND a.marked_by IS DISTINCT FROM i.user_id) AS by_other,
       mu.role::text       AS marker_role,
       CASE WHEN a.id IS NULL THEN NULL ELSE COALESCE(mi.full_name, mu.username) END AS marked_by_name
FROM students s
JOIN instructors i  ON i.id = s.instructor_id AND NOT i.is_holding_pool
JOIN users iu       ON iu.id = i.user_id AND iu.deleted_at IS NULL AND iu.is_active
LEFT JOIN attendance a   ON a.student_id = s.id AND a.date = $1::date
LEFT JOIN users mu       ON mu.id = a.marked_by
LEFT JOIN instructors mi ON mi.user_id = a.marked_by
WHERE (s.deleted_at IS NULL OR a.id IS NOT NULL)
  AND ((s.created_at AT TIME ZONE $4::text) AT TIME ZONE $3::text)::date <= $1::date
  AND ($2::text IS NULL OR s.instructor_id = $2::text)
ORDER BY i.full_name, s.full_name`;

/**
 * Days on which anything was recorded, between two days, optionally for one
 * حلقة.   $1 from   $2 to   $3 instructor id or NULL
 */
export const RECORDED_DAYS_SQL = `
SELECT a.date::text AS day, count(*)::int AS records
FROM attendance a
JOIN students s ON s.id = a.student_id
JOIN instructors i ON i.id = s.instructor_id AND NOT i.is_holding_pool
WHERE a.date BETWEEN $1::date AND $2::date
  AND ($3::text IS NULL OR s.instructor_id = $3::text)
GROUP BY a.date
ORDER BY a.date`;

/** Session days per ISO weekday inside one course.   $1 from   $2 to */
export const WEEKDAY_SPREAD_SQL = `
SELECT EXTRACT(ISODOW FROM a.date)::int AS isodow, count(DISTINCT a.date)::int AS days
FROM attendance a
WHERE a.date BETWEEN $1::date AND $2::date
GROUP BY 1
ORDER BY 1`;

/** Students parked in a holding pool, for the "frozen" count.  (no params) */
export const HOLDING_COUNT_SQL = `
SELECT count(*)::int AS n
FROM students s JOIN instructors i ON i.id = s.instructor_id
WHERE s.deleted_at IS NULL AND i.is_holding_pool`;
