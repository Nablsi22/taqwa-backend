/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SQL behind the evening notifications.
 *
 * Same contract as attendance-stats.sql.ts: parameters bound as strings (or
 * string arrays) and cast in SQL, values cast to driver-neutral types. The
 * only writes are to `scheduled_notifications` (the dedup key and the log)
 * and clearing a device token Firebase reports as no longer registered.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The أساتذة behind some حلقات, with the account that receives.   $1 text[] instructor ids */
export const INSTRUCTOR_RECIPIENTS_SQL = `
SELECT i.id::text      AS instructor_id,
       i.full_name     AS name,
       u.id::text      AS user_id,
       u.fcm_token     AS token
FROM instructors i
JOIN users u ON u.id = i.user_id
WHERE i.id = ANY ($1::text[])
  AND u.is_active
  AND u.deleted_at IS NULL`;

/** «استلمتُ هذه الحلقة اليوم» claims of one day.   $1 day */
export const COVERAGE_OF_DAY_SQL = `
SELECT c.halaqa_instructor_id::text   AS halaqa_instructor_id,
       c.covering_instructor_id::text AS covering_instructor_id,
       ci.full_name                   AS covering_name
FROM halaqa_coverage c
JOIN instructors ci ON ci.id = c.covering_instructor_id
WHERE c.date = $1::date
ORDER BY c.created_at`;

/** Every active course-director account.   (no params) */
export const SUPERVISOR_RECIPIENTS_SQL = `
SELECT u.id::text  AS user_id,
       u.username  AS name,
       u.fcm_token AS token
FROM users u
WHERE u.role::text = 'SUPERVISOR'
  AND u.is_active
  AND u.deleted_at IS NULL
ORDER BY u.username`;

/** One account's device token.   $1 user id */
export const USER_TOKEN_SQL = `
SELECT u.id::text AS user_id, u.username AS name, u.fcm_token AS token
FROM users u
WHERE u.id = $1::text`;

/**
 * Claim one notification before sending it. Returns the row id only to the
 * caller that may send:
 *   • a new key → inserted → send;
 *   • a key already sent, or in flight (no error yet) → nothing → skip;
 *   • a key whose earlier send failed for a passing reason → re-claimed →
 *     send again (a catch-up run retries; a dead token is never retried).
 * The ON CONFLICT … WHERE runs under the row lock, so two runs at the same
 * moment cannot both claim the same key.
 *
 *   $1 id  $2 kind  $3 user id  $4 day  $5 ref key
 */
export const CLAIM_SQL = `
INSERT INTO scheduled_notifications (id, kind, user_id, day, ref_key, title, body)
VALUES ($1::text, $2::text, $3::text, $4::date, $5::text, '', '')
ON CONFLICT (kind, user_id, ref_key) DO UPDATE
   SET error = NULL
 WHERE scheduled_notifications.sent = false
   AND scheduled_notifications.error IS NOT NULL
   AND scheduled_notifications.error <> 'invalid-token'
RETURNING id::text AS id`;

/** The outcome of a send.   $1 text[] ids  $2 title  $3 body  $4 sent  $5 error */
export const SETTLE_SQL = `
UPDATE scheduled_notifications
   SET title = $2::text, body = $3::text, sent = $4::boolean, error = $5::text
 WHERE id = ANY ($1::text[])`;

/** Firebase says this device is gone: stop sending to it.   $1 token */
export const CLEAR_TOKEN_SQL = `
UPDATE users SET fcm_token = NULL WHERE fcm_token = $1::text`;

/** What went out on one day, for the admin.   $1 day */
export const LOG_OF_DAY_SQL = `
SELECT n.kind,
       n.title,
       n.body,
       n.sent,
       n.error,
       to_char(n.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
       COALESCE(i.full_name, u.username)                AS recipient,
       u.role::text                                     AS role
FROM scheduled_notifications n
LEFT JOIN users u       ON u.id = n.user_id
LEFT JOIN instructors i ON i.user_id = n.user_id
WHERE n.day = $1::date
ORDER BY n.created_at, n.kind`;
