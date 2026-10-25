/* eslint-disable no-console */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * scripts/preflight-attendance-features.ts
 *
 * READ-ONLY pre-flight before the attendance / supervisor / notifications
 * work. It changes nothing: every query runs inside one
 * `REPEATABLE READ, READ ONLY` transaction, so PostgreSQL itself rejects any
 * write, and every number in the report comes from one consistent snapshot.
 *
 * It answers two questions:
 *
 *   A. What happens on the next deploy?
 *      The Dockerfile runs `prisma migrate deploy` on every boot. Every
 *      migration folder on disk that is not recorded in `_prisma_migrations`
 *      will run against production the moment anything is pushed — including
 *      20260905000000_course_isolation_and_verse_range, which is still
 *      uncommitted locally. This section lists exactly what would run and
 *      what it would touch.
 *
 *   B. What will the new features show, with today's real data?
 *      A preview of the agreed rules, computed on the active course:
 *        • last session day ("آخر يوم دوام")
 *        • per-حلقة attendance on that day, and which instructors did not
 *          record attendance at all
 *        • every student classified as ثابت / متذبذب / منقطع
 *        • which students would trigger the "اتصل وطمّن عليه" alert now
 *        • how often attendance / recitation is already recorded by an
 *          instructor other than the student's own (التسجيل بالنيابة)
 *        • the schools students are enrolled in, and how many spellings of
 *          the same school the free-text `students.school` column holds
 *
 * Rules previewed (all in CONFIG below — change them there, nowhere else)
 *   • A session of a حلقة = a date on which at least one of that instructor's
 *     students has an attendance record. A student is only ever measured
 *     against sessions their حلقة actually held, and only from the day they
 *     joined, so no student is penalised for an instructor who did not mark.
 *   • Required vs optional days. Winter: Saturday is required, Thursday is
 *     an OPTIONAL day for students who memorise ("نكافئ يلي بيجي وما نخصم
 *     من يلي بيغيب"). An optional day — and any make-up day outside the
 *     schedule — only ever counts in a student's favour: it is a session
 *     for them only if they attended it. Only a REQUIRED day can be missed.
 *   • Window = the last 28 days.
 *       منقطع  (INACTIVE)   attended 0 sessions in the window
 *       ثابت   (REGULAR)    missed at most 1 required session in the window
 *       متذبذب (IRREGULAR)  everything in between
 *       NO_DATA             their حلقة recorded no session in the window
 *     LATE counts as attended. A required session with no record for the
 *     student counts as missed for the window, and is reported separately.
 *   • Alert = the student's last 2 required sessions are both ABSENT; an
 *     attended optional day in between ends the streak.
 *   • Students of a holding حلقة ("عزل" — frozen students) are left out of
 *     every number and reported as one count.
 *
 * Usage (PowerShell, from the backend folder):
 *   $env:PREFLIGHT_DATABASE_URL = '<Railway → Postgres → DATABASE_PUBLIC_URL>'
 *   npx ts-node --transpile-only scripts/preflight-attendance-features.ts
 *   Remove-Item Env:PREFLIGHT_DATABASE_URL
 *
 * Output: a console report + exports/preflight-attendance-<runId>.csv
 *
 * References
 *   Read-only transactions   https://www.postgresql.org/docs/current/sql-set-transaction.html
 *   ISODOW / date arithmetic https://www.postgresql.org/docs/current/functions-datetime.html
 *   FILTER clause            https://www.postgresql.org/docs/current/sql-expressions.html#SYNTAX-AGGREGATES
 *   Window functions         https://www.postgresql.org/docs/current/tutorial-window.html
 *   Prisma raw queries       https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries
 *   migrate deploy           https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production#production-and-testing-environments
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/** ISO weekday numbers, as PostgreSQL's EXTRACT(ISODOW): Monday = 1 … Sunday = 7. */
export type IsoDow = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const CONFIG = {
  /** The mosque's calendar. Syria is on permanent UTC+03:00. */
  localTimeZone: 'Asia/Damascus',
  /** Prisma writes DateTime as UTC into `timestamp(3)` columns. */
  storedTimeZone: 'UTC',
  /**
   * Meeting days per course, matched against the course's `name` / `name_ar`.
   * Phase 1 moves this onto the course row itself (`terms.meeting_days`).
   */
  meetingDays: [
    { match: /winter|شتو/i, required: [6] as IsoDow[], optional: [4] as IsoDow[], label: 'السبت إلزامي + الخميس اختياري' },
    { match: /summer|صيف/i, required: [6, 1, 3] as IsoDow[], optional: [] as IsoDow[], label: 'سبت + اثنين + أربعاء' },
  ],
  /**
   * Instructors whose "حلقة" is a holding pool for frozen students. Phase 1
   * replaces this with a flag on the instructor row.
   */
  holdingInstructorNames: ['عزل'],
  /** Look-back window, in days, for ثابت / منقطع. */
  windowDays: 28,
  /** ثابت = missed at most this many sessions inside the window. */
  regularMaxMissed: 1,
  /** "اتصل وطمّن عليه" fires once this many consecutive sessions are ABSENT. */
  alertConsecutiveAbsences: 2,
  /** The migration whose deploy state matters for this release. */
  courseMigration: '20260905000000_course_isolation_and_verse_range',
  txTimeoutMs: 60_000,
} as const;

const DOW_AR: Record<IsoDow, string> = {
  1: 'الاثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
  7: 'الأحد',
};

// ═══════════════════════════════════════════════════════════════════════════
// Database port — same contract as scripts/winter-2026-split.ts: the script
// talks to PostgreSQL only through this, so the exact same SQL runs on Prisma
// in production and on node-postgres in tests. Every parameter is a string
// (or null) and every value is cast in SQL, so both drivers bind and return
// identical types (counts are cast to int, dates to text).
// ═══════════════════════════════════════════════════════════════════════════

export type Param = string | null;
export type Row = Record<string, unknown>;

export interface Tx {
  query<T extends Row = Row>(sql: string, ...params: Param[]): Promise<T[]>;
  exec(sql: string, ...params: Param[]): Promise<number>;
}

export interface Db {
  transaction<T>(fn: (tx: Tx) => Promise<T>, timeoutMs: number): Promise<T>;
}

/** The two raw-SQL methods of Prisma.TransactionClient this script uses. */
interface RawSqlClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export function prismaDb(prisma: PrismaClient): Db {
  return {
    transaction: <T>(fn: (tx: Tx) => Promise<T>, timeoutMs: number): Promise<T> =>
      prisma.$transaction(
        (t: RawSqlClient) =>
          fn({
            query: <R extends Row = Row>(sql: string, ...p: Param[]) =>
              t.$queryRawUnsafe<R[]>(sql, ...p),
            exec: (sql: string, ...p: Param[]) => t.$executeRawUnsafe(sql, ...p),
          }),
        { maxWait: 15_000, timeout: timeoutMs },
      ) as Promise<T>,
  };
}

/** A deliberate stop. Nothing is ever written by this script. */
export class Abort extends Error {}

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type Classification = 'REGULAR' | 'IRREGULAR' | 'INACTIVE' | 'NO_DATA';

const CLASS_AR: Record<Classification, string> = {
  REGULAR: 'ثابت',
  IRREGULAR: 'متذبذب',
  INACTIVE: 'منقطع',
  NO_DATA: 'لا توجد جلسات مسجّلة لحلقته',
};

interface MigrationRow extends Row {
  migration_name: string;
  finished_at: string | null;
  rolled_back_at: string | null;
}

interface TriggerRow extends Row {
  name: string;
  tbl: string;
  enabled: string;
}

interface TermRow extends Row {
  id: number;
  name: string;
  name_ar: string;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
}

interface WeekdayRow extends Row {
  term_id: number;
  isodow: number;
  days: number;
  records: number;
}

interface DayCountRow extends Row {
  d: string;
  n: number;
}

export interface HalaqaDayRow extends Row {
  instructor_id: string;
  instructor: string;
  students: number;
  marked: number;
  present: number;
  late: number;
  absent: number;
  marked_by_others: number;
  other_markers: string | null;
}

export interface StudentPreviewRow extends Row {
  student_id: string;
  instructor: string;
  student: string;
  father: string;
  joined: string;
  sessions: number;
  present: number;
  late: number;
  absent: number;
  unmarked: number;
  win_sessions: number;
  win_attended: number;
  absent_streak: number;
  last_attended: string | null;
}

export interface StudentPreview extends StudentPreviewRow {
  classification: Classification;
  alert: boolean;
}

export interface Report {
  db: { version: string; timeZone: string; today: string };
  deploy: {
    migrationsTable: boolean;
    applied: MigrationRow[];
    pendingOnDisk: string[];
    failed: MigrationRow[];
    courseMigrationApplied: boolean;
    triggers: TriggerRow[];
    courseConstraints: string[];
    nullTermIds: { table: string; exists: boolean; rows: number }[];
    auditLedger: { migration: string; rows: number }[] | null;
    fullSuraSinceCutoff: { rows: number; last: string | null };
    roleLabels: string[];
  };
  terms: TermRow[];
  weekdays: WeekdayRow[];
  active: null | {
    term: TermRow;
    requiredDays: IsoDow[];
    optionalDays: IsoDow[];
    meetingDaysSource: string;
    holdingStudents: number;
    lastOptional: { day: string | null; attended: number };
    windowStart: string;
    lastSession: { scheduled: string | null; withRecords: string | null };
    halaqas: HalaqaDayRow[];
    students: StudentPreview[];
    substitution: {
      attendance: { total: number; byOwn: number; byOtherInstructor: number; byAdmin: number; byUnknown: number };
      recitations: { total: number; byOther: number };
    };
  };
  push: { role: string; users: number; with_token: number }[];
  schools: { withSchool: number; withoutSchool: number; rawDistinct: number; groups: SchoolGroup[] };
  warnings: string[];
}

export interface SchoolGroup {
  key: string;
  /** The most common spelling — what the filter would display. */
  label: string;
  students: number;
  variants: { raw: string; students: number }[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers (exported for tests)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Matching key for a free-text school name, so that spellings of one school
 * group together: diacritics and tatweel removed, alef/yaa/taa-marbuta
 * variants unified, the word "مدرسة"/"ثانوية"… and the definite article
 * dropped from the front, digits made Western, spaces collapsed.
 * It only groups for the preview — no stored value is changed.
 */
export function normalizeSchool(raw: string): string {
  let s = raw
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // harakat, superscript alef, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  s = s.replace(/^(مدرسه|مدارس|ثانويه|اعداديه|ابتدائيه|معهد|روضه)\s+/, '');
  s = s.replace(/^(ال)(?=\S{3,})/, '');
  return s;
}

/** A PostgreSQL text[] literal, e.g. ['a', 'b"c'] → {"a","b\\"c"}. Bound as one string parameter. */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

export function groupSchools(rows: { school: string; n: number }[]): SchoolGroup[] {
  const byKey = new Map<string, SchoolGroup>();
  for (const r of rows) {
    const key = normalizeSchool(r.school);
    const g = byKey.get(key) ?? { key, label: r.school, students: 0, variants: [] };
    g.students += r.n;
    g.variants.push({ raw: r.school, students: r.n });
    byKey.set(key, g);
  }
  return [...byKey.values()]
    .map((g) => {
      g.variants.sort((a, b) => b.students - a.students || a.raw.localeCompare(b.raw, 'ar'));
      g.label = g.variants[0].raw;
      return g;
    })
    .sort((a, b) => b.students - a.students || a.label.localeCompare(b.label, 'ar'));
}

/** ISO weekday of a YYYY-MM-DD calendar date. */
export function isoDow(day: string): IsoDow {
  const js = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as IsoDow;
}

/** YYYY-MM-DD plus `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * "آخر يوم دوام": the most recent meeting day on or before `today`, inside
 * the course. Today itself only counts once at least one attendance record
 * exists for it — otherwise someone opening the app at 10 am on a Saturday
 * would read a day that has not happened yet as "nobody came".
 *
 *   scheduled    the last meeting day by the calendar, recorded or not
 *   withRecords  the last meeting day that actually has attendance records
 */
export function lastSessionDay(
  today: string,
  courseStart: string,
  meetingDays: readonly IsoDow[],
  recordedDays: ReadonlySet<string>,
): { scheduled: string | null; withRecords: string | null } {
  let scheduled: string | null = null;
  let withRecords: string | null = null;
  for (let d = today; d >= courseStart; d = addDays(d, -1)) {
    if (!meetingDays.includes(isoDow(d))) continue;
    if (d === today && !recordedDays.has(d)) continue;
    scheduled ??= d;
    if (recordedDays.has(d)) {
      withRecords = d;
      break;
    }
  }
  return { scheduled, withRecords };
}

export function classify(r: Pick<StudentPreviewRow, 'win_sessions' | 'win_attended'>): Classification {
  if (r.win_sessions === 0) return 'NO_DATA';
  if (r.win_attended === 0) return 'INACTIVE';
  if (r.win_sessions - r.win_attended <= CONFIG.regularMaxMissed) return 'REGULAR';
  return 'IRREGULAR';
}

export function meetingDaysFor(
  term: Pick<TermRow, 'name' | 'name_ar'>,
): { required: IsoDow[]; optional: IsoDow[]; label: string } | null {
  const hit = CONFIG.meetingDays.find((m) => m.match.test(term.name) || m.match.test(term.name_ar));
  return hit ? { required: [...hit.required], optional: [...hit.optional], label: hit.label } : null;
}

/** Fallback when a course name matches no rule: its weekdays that hold ≥ 10 % of its session days. */
export function inferMeetingDays(rows: WeekdayRow[]): IsoDow[] {
  const total = rows.reduce((s, r) => s + r.days, 0);
  return rows
    .filter((r) => total > 0 && r.days / total >= 0.1)
    .map((r) => r.isodow as IsoDow)
    .sort((a, b) => a - b);
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Per-student preview on one course.
 *   $1 term id   $2 today (local)   $3 window days   $4 local tz   $5 stored tz
 *   $6 REQUIRED meeting days as a PostgreSQL int[] literal, e.g. '{6}'
 *   $7 holding-pool instructor names as a text[] literal, e.g. '{عزل}'
 */
export const STUDENT_PREVIEW_SQL = `
WITH
term AS (
  SELECT id, start_date, COALESCE(end_date, DATE '9999-12-31') AS end_date
  FROM terms WHERE id = $1::int
),
bounds AS (
  SELECT t.start_date              AS lo,
         LEAST(t.end_date, $2::date) AS hi,
         ($2::date - ($3::int - 1))  AS win_lo
  FROM term t
),
st AS (
  SELECT s.id, s.full_name, s.father_name, s.instructor_id,
         GREATEST(
           b.lo,
           ((s.created_at AT TIME ZONE $5::text) AT TIME ZONE $4::text)::date
         ) AS joined
  FROM students s
  JOIN instructors i ON i.id = s.instructor_id
  CROSS JOIN bounds b
  WHERE s.deleted_at IS NULL
    AND NOT (i.full_name = ANY ($7::text[]))
),
-- A session of a حلقة: any date on which one of its students has a record.
sessions AS (
  SELECT DISTINCT s.instructor_id, a.date
  FROM attendance a
  JOIN students s ON s.id = a.student_id
  CROSS JOIN bounds b
  WHERE a.date BETWEEN b.lo AND b.hi
),
grid AS (
  SELECT st.id, se.date, a.status::text AS status
  FROM st
  JOIN sessions se ON se.instructor_id = st.instructor_id AND se.date >= st.joined
  LEFT JOIN attendance a ON a.student_id = st.id AND a.date = se.date
  -- Only a REQUIRED day can be missed. An optional day (winter Thursday) or
  -- a make-up day counts for a student only if they attended it.
  WHERE EXTRACT(ISODOW FROM se.date)::int = ANY ($6::int[])
     OR a.status IN ('PRESENT', 'LATE')
),
ranked AS (
  SELECT g.*, row_number() OVER (PARTITION BY g.id ORDER BY g.date DESC) AS rn
  FROM grid g
),
agg AS (
  SELECT r.id,
    count(*)::int                                            AS sessions,
    count(*) FILTER (WHERE r.status = 'PRESENT')::int        AS present,
    count(*) FILTER (WHERE r.status = 'LATE')::int           AS late,
    count(*) FILTER (WHERE r.status = 'ABSENT')::int         AS absent,
    count(*) FILTER (WHERE r.status IS NULL)::int            AS unmarked,
    count(*) FILTER (WHERE r.date >= (SELECT win_lo FROM bounds))::int AS win_sessions,
    count(*) FILTER (
      WHERE r.date >= (SELECT win_lo FROM bounds) AND r.status IN ('PRESENT', 'LATE')
    )::int                                                   AS win_attended,
    -- consecutive ABSENT records counted from the latest session backwards;
    -- an unmarked session ends the streak (we do not alert on unknowns)
    COALESCE(min(r.rn) FILTER (WHERE r.status IS DISTINCT FROM 'ABSENT') - 1, max(r.rn))::int
                                                             AS absent_streak,
    (max(r.date) FILTER (WHERE r.status IN ('PRESENT', 'LATE')))::text AS last_attended
  FROM ranked r
  GROUP BY r.id
)
SELECT st.id::text                     AS student_id,
       i.full_name                     AS instructor,
       st.full_name                    AS student,
       st.father_name                  AS father,
       st.joined::text                 AS joined,
       COALESCE(a.sessions, 0)::int     AS sessions,
       COALESCE(a.present, 0)::int      AS present,
       COALESCE(a.late, 0)::int         AS late,
       COALESCE(a.absent, 0)::int       AS absent,
       COALESCE(a.unmarked, 0)::int     AS unmarked,
       COALESCE(a.win_sessions, 0)::int AS win_sessions,
       COALESCE(a.win_attended, 0)::int AS win_attended,
       COALESCE(a.absent_streak, 0)::int AS absent_streak,
       a.last_attended
FROM st
JOIN instructors i ON i.id = st.instructor_id
LEFT JOIN agg a ON a.id = st.id
ORDER BY i.full_name, st.full_name`;

/**
 * Every حلقة on one day.  $1 day   $2 holding-pool names as a text[] literal
 * Instructors with no current student, and holding pools, are left out.
 */
export const HALAQA_DAY_SQL = `
SELECT i.id::text  AS instructor_id,
       i.full_name AS instructor,
       count(DISTINCT s.id)::int                                   AS students,
       count(a.id)::int                                            AS marked,
       count(a.id) FILTER (WHERE a.status = 'PRESENT')::int        AS present,
       count(a.id) FILTER (WHERE a.status = 'LATE')::int           AS late,
       count(a.id) FILTER (WHERE a.status = 'ABSENT')::int         AS absent,
       count(a.id) FILTER (WHERE a.marked_by IS DISTINCT FROM i.user_id)::int AS marked_by_others,
       string_agg(
         DISTINCT CASE WHEN a.marked_by IS DISTINCT FROM i.user_id
                       THEN COALESCE(mi.full_name, mu.username) END,
         '، '
       ) AS other_markers
FROM instructors i
JOIN users u        ON u.id = i.user_id AND u.deleted_at IS NULL AND u.is_active
JOIN students s     ON s.instructor_id = i.id AND s.deleted_at IS NULL
LEFT JOIN attendance a  ON a.student_id = s.id AND a.date = $1::date
LEFT JOIN users mu      ON mu.id = a.marked_by
LEFT JOIN instructors mi ON mi.user_id = a.marked_by
WHERE NOT (i.full_name = ANY ($2::text[]))
GROUP BY i.id, i.full_name
ORDER BY i.full_name`;

// ═══════════════════════════════════════════════════════════════════════════
// Collect
// ═══════════════════════════════════════════════════════════════════════════

async function tableExists(tx: Tx, table: string): Promise<boolean> {
  const [r] = await tx.query<{ ok: boolean }>(`SELECT to_regclass($1::text) IS NOT NULL AS ok`, `public.${table}`);
  return r.ok;
}

export async function collect(db: Db, opts: { migrationsDir: string; today?: string }): Promise<Report> {
  return db.transaction(async (tx) => {
    // Must be the first statement of the transaction.
    await tx.exec(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const warnings: string[] = [];

    const [meta] = await tx.query<{ version: string; tz: string; today: string }>(
      `SELECT current_setting('server_version') AS version,
              current_setting('TimeZone')       AS tz,
              ((now() AT TIME ZONE $1::text)::date)::text AS today`,
      CONFIG.localTimeZone,
    );
    const today = opts.today ?? meta.today;

    // ── A. Deploy state ──────────────────────────────────────────────────
    const migrationsTable = await tableExists(tx, '_prisma_migrations');
    const applied = migrationsTable
      ? await tx.query<MigrationRow>(
          `SELECT migration_name, finished_at::text AS finished_at, rolled_back_at::text AS rolled_back_at
           FROM _prisma_migrations ORDER BY started_at`,
        )
      : [];
    const onDisk = fs.existsSync(opts.migrationsDir)
      ? fs
          .readdirSync(opts.migrationsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && fs.existsSync(path.join(opts.migrationsDir, e.name, 'migration.sql')))
          .map((e) => e.name)
          .sort()
      : [];
    if (onDisk.length === 0) warnings.push(`No migrations found under ${opts.migrationsDir} — run from the backend folder.`);

    const done = new Set(applied.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name));
    const failed = applied.filter((m) => !m.finished_at && !m.rolled_back_at);
    const pendingOnDisk = onDisk.filter((n) => !done.has(n));
    for (const m of applied) {
      if (!onDisk.includes(m.migration_name)) {
        warnings.push(`"${m.migration_name}" is recorded in the database but missing from disk.`);
      }
    }
    if (failed.length) {
      warnings.push(
        `${failed.length} failed migration(s) are recorded — prisma migrate deploy refuses to run until they are resolved (P3009).`,
      );
    }

    const triggers = await tx.query<TriggerRow>(
      `SELECT t.tgname::text AS name, c.relname::text AS tbl, t.tgenabled::text AS enabled
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgname ILIKE '%term%'
       ORDER BY c.relname, t.tgname`,
    );
    const courseConstraints = (
      await tx.query<{ name: string }>(
        `SELECT conname::text AS name FROM pg_constraint
         WHERE conname LIKE '%term_required_chk' OR conname = 'recitations_verse_range_chk'
         ORDER BY conname`,
      )
    ).map((r) => r.name);

    const nullTermIds: Report['deploy']['nullTermIds'] = [];
    for (const table of ['recitations', 'points_log', 'hadith_recitations']) {
      const exists = await tableExists(tx, table);
      const rows = exists
        ? (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE term_id IS NULL`))[0].n
        : 0;
      nullTermIds.push({ table, exists, rows });
    }

    const auditLedger = (await tableExists(tx, 'term_backfill_audit'))
      ? await tx.query<{ migration: string; rows: number }>(
          `SELECT migration, count(*)::int AS rows FROM term_backfill_audit GROUP BY migration ORDER BY migration`,
        )
      : null;

    // Recitations in the old "whole sura" shape written after the 2026-09-05
    // cutoff. The new backend rejects that shape, so recent rows here mean the
    // OLD backend is what is live on Railway.
    const [fullSura] = await tx.query<{ rows: number; last: string | null }>(
      `SELECT count(*)::int AS rows, (max(created_at))::text AS last
       FROM recitations
       WHERE created_at >= TIMESTAMP '2026-09-05 00:00:00'
         AND rating <> 'MAQRAA'
         AND ("startAya" IS NULL OR "endAya" IS NULL)`,
    );

    const roleLabels = (
      await tx.query<{ label: string }>(
        `SELECT e.enumlabel::text AS label
         FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
         WHERE ty.typname = 'Role' ORDER BY e.enumsortorder`,
      )
    ).map((r) => r.label);

    // ── Courses ─────────────────────────────────────────────────────────
    const terms = await tx.query<TermRow>(
      `SELECT id::int AS id, name, name_ar, start_date::text AS start_date,
              end_date::text AS end_date, is_active
       FROM terms ORDER BY start_date, id`,
    );
    const weekdays = await tx.query<WeekdayRow>(
      `SELECT t.id::int AS term_id,
              EXTRACT(ISODOW FROM a.date)::int AS isodow,
              count(DISTINCT a.date)::int      AS days,
              count(*)::int                    AS records
       FROM terms t
       JOIN attendance a
         ON a.date >= t.start_date AND a.date <= COALESCE(t.end_date, DATE '9999-12-31')
       GROUP BY t.id, 2
       ORDER BY t.id, 2`,
    );

    const schoolRows = await tx.query<{ school: string | null; n: number }>(
      `SELECT NULLIF(btrim(s.school), '') AS school, count(*)::int AS n
       FROM students s JOIN instructors i ON i.id = s.instructor_id
       WHERE s.deleted_at IS NULL AND NOT (i.full_name = ANY ($1::text[]))
       GROUP BY 1`,
      pgTextArray(CONFIG.holdingInstructorNames),
    );
    const named = schoolRows.filter((r): r is { school: string; n: number } => r.school !== null);
    const schools = {
      withSchool: named.reduce((t, r) => t + r.n, 0),
      withoutSchool: schoolRows.filter((r) => r.school === null).reduce((t, r) => t + r.n, 0),
      rawDistinct: named.length,
      groups: groupSchools(named),
    };

    const push = await tx.query<{ role: string; users: number; with_token: number }>(
      `SELECT role::text AS role, count(*)::int AS users,
              count(*) FILTER (WHERE fcm_token IS NOT NULL AND fcm_token <> '')::int AS with_token
       FROM users WHERE deleted_at IS NULL AND is_active
       GROUP BY role ORDER BY role`,
    );

    // ── B. Active-course preview ─────────────────────────────────────────
    const activeTerms = terms.filter((t) => t.is_active);
    if (activeTerms.length !== 1) warnings.push(`Expected exactly one active course, found ${activeTerms.length}.`);
    const term = activeTerms[0];

    let active: Report['active'] = null;
    if (term) {
      const configured = meetingDaysFor(term);
      const termWeekdays = weekdays.filter((w) => w.term_id === term.id);
      const requiredDays = configured?.required ?? inferMeetingDays(termWeekdays);
      const optionalDays = configured?.optional ?? [];
      const meetingDays = [...requiredDays, ...optionalDays];
      const meetingDaysSource = configured
        ? `CONFIG (${configured.label})`
        : `inferred from data (${requiredDays.map((d) => DOW_AR[d]).join(' + ') || 'none'})`;
      const holding = pgTextArray(CONFIG.holdingInstructorNames);
      if (!configured) warnings.push(`Course "${term.name}" matches no meeting-days rule; inferred from data.`);

      for (const w of termWeekdays) {
        if (!meetingDays.includes(w.isodow as IsoDow)) {
          warnings.push(
            `${w.records} attendance record(s) on ${w.days} ${DOW_AR[w.isodow as IsoDow]}(s) — not a meeting day of "${term.name}".`,
          );
        }
      }

      const recordedDays = new Set(
        (
          await tx.query<DayCountRow>(
            `SELECT a.date::text AS d, count(*)::int AS n FROM attendance a
             WHERE a.date >= $1::date AND a.date <= $2::date
             GROUP BY a.date`,
            term.start_date,
            today,
          )
        ).map((r) => r.d),
      );
      const lastSession = lastSessionDay(today, term.start_date, requiredDays, recordedDays);
      const lastOptionalDay = optionalDays.length
        ? lastSessionDay(today, term.start_date, optionalDays, recordedDays).withRecords
        : null;
      const [optAttended] = lastOptionalDay
        ? await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM attendance a
             JOIN students s ON s.id = a.student_id AND s.deleted_at IS NULL
             JOIN instructors i ON i.id = s.instructor_id
             WHERE a.date = $1::date AND a.status IN ('PRESENT', 'LATE')
               AND NOT (i.full_name = ANY ($2::text[]))`,
            lastOptionalDay,
            holding,
          )
        : [{ n: 0 }];
      const [holdingRow] = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM students s JOIN instructors i ON i.id = s.instructor_id
         WHERE s.deleted_at IS NULL AND i.full_name = ANY ($1::text[])`,
        holding,
      );
      if (lastSession.scheduled && lastSession.scheduled !== lastSession.withRecords) {
        warnings.push(
          `Last scheduled meeting day ${lastSession.scheduled} has NO attendance at all (holiday, or nobody marked).`,
        );
      }

      const halaqas = lastSession.withRecords
        ? await tx.query<HalaqaDayRow>(HALAQA_DAY_SQL, lastSession.withRecords, holding)
        : [];

      const rows = await tx.query<StudentPreviewRow>(
        STUDENT_PREVIEW_SQL,
        String(term.id),
        today,
        String(CONFIG.windowDays),
        CONFIG.localTimeZone,
        CONFIG.storedTimeZone,
        `{${requiredDays.join(',')}}`,
        holding,
      );
      const students: StudentPreview[] = rows.map((r) => ({
        ...r,
        classification: classify(r),
        alert: r.absent_streak >= CONFIG.alertConsecutiveAbsences,
      }));

      const [att] = await tx.query<{
        total: number;
        by_own: number;
        by_other_instructor: number;
        by_admin: number;
        by_unknown: number;
      }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE a.marked_by = i.user_id)::int AS by_own,
                count(*) FILTER (WHERE a.marked_by <> i.user_id AND mu.role = 'INSTRUCTOR')::int AS by_other_instructor,
                count(*) FILTER (WHERE mu.role = 'ADMIN')::int AS by_admin,
                count(*) FILTER (WHERE mu.id IS NULL)::int AS by_unknown
         FROM attendance a
         JOIN students s    ON s.id = a.student_id
         JOIN instructors i ON i.id = s.instructor_id
         LEFT JOIN users mu ON mu.id = a.marked_by
         WHERE a.date >= $1::date AND a.date <= $2::date`,
        term.start_date,
        today,
      );
      const [rec] = await tx.query<{ total: number; by_other: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (
                  WHERE r.instructor_id <> s.instructor_id AND r.instructor_id <> i.user_id
                )::int AS by_other
         FROM recitations r
         JOIN students s    ON s.id = r.student_id
         JOIN instructors i ON i.id = s.instructor_id
         WHERE r.term_id = $1::int`,
        String(term.id),
      );

      active = {
        term,
        requiredDays,
        optionalDays,
        meetingDaysSource,
        holdingStudents: holdingRow.n,
        lastOptional: { day: lastOptionalDay, attended: optAttended.n },
        windowStart: addDays(today, -(CONFIG.windowDays - 1)),
        lastSession,
        halaqas,
        students,
        substitution: {
          attendance: {
            total: att.total,
            byOwn: att.by_own,
            byOtherInstructor: att.by_other_instructor,
            byAdmin: att.by_admin,
            byUnknown: att.by_unknown,
          },
          recitations: { total: rec.total, byOther: rec.by_other },
        },
      };
    }

    return {
      db: { version: meta.version, timeZone: meta.tz, today },
      deploy: {
        migrationsTable,
        applied,
        pendingOnDisk,
        failed,
        courseMigrationApplied: done.has(CONFIG.courseMigration),
        triggers,
        courseConstraints,
        nullTermIds,
        auditLedger,
        fullSuraSinceCutoff: { rows: fullSura.rows, last: fullSura.last },
        roleLabels,
      },
      terms,
      weekdays,
      active,
      push,
      schools,
      warnings,
    };
  }, CONFIG.txTimeoutMs);
}

// ═══════════════════════════════════════════════════════════════════════════
// Reporting
// ═══════════════════════════════════════════════════════════════════════════

export function printReport(r: Report): void {
  const line = '─'.repeat(78);
  const h = (t: string) => console.log(`\n${line}\n${t}\n${line}`);

  console.log(`\nPostgreSQL ${r.db.version} · TimeZone=${r.db.timeZone} · today (Damascus) = ${r.db.today}`);
  console.log('READ ONLY — nothing was written.');

  h('A. DEPLOY STATE — what the next `prisma migrate deploy` will do');
  if (!r.deploy.migrationsTable) console.log('  ⚠ _prisma_migrations does not exist.');
  console.log(`  applied migrations: ${r.deploy.applied.length}  (last: ${r.deploy.applied.at(-1)?.migration_name ?? '—'})`);
  console.log(
    `  ${CONFIG.courseMigration}: ${r.deploy.courseMigrationApplied ? 'APPLIED' : 'NOT APPLIED → will run on next deploy'}`,
  );
  console.log(`  pending (on disk, not in DB): ${r.deploy.pendingOnDisk.length ? '' : 'none'}`);
  r.deploy.pendingOnDisk.forEach((n) => console.log(`    • ${n}`));
  r.deploy.failed.forEach((m) => console.log(`  ✗ FAILED migration recorded: ${m.migration_name}`));
  console.log(
    `  term triggers: ${r.deploy.triggers.map((t) => `${t.tbl}.${t.name}=${t.enabled}`).join(', ') || 'none'}`,
  );
  console.log(`  course constraints: ${r.deploy.courseConstraints.join(', ') || 'none'}`);
  console.log('  rows the course migration would backfill (term_id IS NULL):');
  r.deploy.nullTermIds.forEach((n) =>
    console.log(`    ${n.table.padEnd(20)} ${n.exists ? String(n.rows).padStart(6) : ' table missing'}`),
  );
  console.log(
    `  term_backfill_audit: ${
      r.deploy.auditLedger ? r.deploy.auditLedger.map((a) => `${a.migration}=${a.rows}`).join(', ') || 'empty' : 'missing'
    }`,
  );
  console.log(
    `  "whole sura" recitations written since 2026-09-05: ${r.deploy.fullSuraSinceCutoff.rows}` +
      (r.deploy.fullSuraSinceCutoff.last ? ` (latest ${r.deploy.fullSuraSinceCutoff.last} UTC)` : '') +
      (r.deploy.fullSuraSinceCutoff.rows > 0 ? '  ← if the latest is recent, the OLD backend is what is live' : ''),
  );
  console.log(`  Role enum: ${r.deploy.roleLabels.join(', ')}`);

  h('COURSES');
  for (const t of r.terms) {
    const wd = r.weekdays
      .filter((w) => w.term_id === t.id)
      .map((w) => `${DOW_AR[w.isodow as IsoDow]}:${w.days}`)
      .join(' ');
    console.log(`  ${String(t.id).padStart(3)} ${t.is_active ? '●' : '○'} ${t.start_date} → ${t.end_date ?? '…'}  ${t.name_ar}`);
    console.log(`        session days by weekday: ${wd || '—'}`);
  }

  if (r.active) {
    const a = r.active;
    h(`B. PREVIEW — ${a.term.name_ar}`);
    console.log(
      `  required days: ${a.requiredDays.map((d) => DOW_AR[d]).join(' + ')}` +
        (a.optionalDays.length ? ` · optional: ${a.optionalDays.map((d) => DOW_AR[d]).join(' + ')}` : '') +
        `  [${a.meetingDaysSource}]`,
    );
    console.log(`  holding pool (${CONFIG.holdingInstructorNames.join('، ')}): ${a.holdingStudents} students — excluded from everything below`);
    if (a.optionalDays.length) {
      console.log(`  last optional day: ${a.lastOptional.day ?? '—'}  (${a.lastOptional.attended} attended)`);
    }
    console.log(`  last required session (calendar):     ${a.lastSession.scheduled ?? '—'}`);
    console.log(`  last required session (with records): ${a.lastSession.withRecords ?? '—'}`);

    if (a.halaqas.length) {
      console.log(`\n  الحلقات يوم ${a.lastSession.withRecords}`);
      console.log('  ' + ['الأستاذ'.padEnd(24), 'طلاب', 'سُجّل', 'حاضر', 'متأخر', 'غائب', 'بالنيابة'].join('  '));
      for (const q of a.halaqas) {
        const flag = q.marked === 0 ? '  ⚠ لم يسجّل الحضور' : '';
        const subs = q.marked_by_others ? `${q.marked_by_others} (${q.other_markers ?? '?'})` : '';
        console.log(
          `  ${q.instructor.padEnd(24)} ${String(q.students).padStart(4)}  ${String(q.marked).padStart(4)}  ` +
            `${String(q.present).padStart(4)}  ${String(q.late).padStart(5)}  ${String(q.absent).padStart(4)}  ${subs}${flag}`,
        );
      }
      const notMarked = a.halaqas.filter((q) => q.marked === 0);
      console.log(`  → instructors who did not record: ${notMarked.length}`);
    }

    const counts = (c: Classification) => a.students.filter((s) => s.classification === c).length;
    const activeCount = counts('REGULAR') + counts('IRREGULAR');
    console.log(`\n  students (not deleted): ${a.students.length}`);
    console.log(`  window: ${a.windowStart} → ${r.db.today}  (${CONFIG.windowDays} days, ثابت = missed ≤ ${CONFIG.regularMaxMissed})`);
    (['REGULAR', 'IRREGULAR', 'INACTIVE', 'NO_DATA'] as Classification[]).forEach((c) =>
      console.log(`    ${CLASS_AR[c].padEnd(28)} ${String(counts(c)).padStart(5)}`),
    );
    console.log(`  → العدد النشِط (ثابت + متذبذب): ${activeCount}`);

    const alerts = a.students.filter((s) => s.alert);
    console.log(`\n  "اتصل وطمّن عليه" alerts if the feature ran now: ${alerts.length}`);
    const byInstructor = new Map<string, number>();
    alerts.forEach((s) => byInstructor.set(s.instructor, (byInstructor.get(s.instructor) ?? 0) + 1));
    [...byInstructor].forEach(([k, v]) => console.log(`    ${k.padEnd(24)} ${v}`));

    const s = a.substitution;
    console.log('\n  recorded by someone other than the student\'s own instructor (this course):');
    console.log(
      `    attendance: ${s.attendance.byOtherInstructor} by another instructor, ${s.attendance.byAdmin} by admin, ` +
        `${s.attendance.byUnknown} unknown marker — of ${s.attendance.total}`,
    );
    console.log(`    recitations: ${s.recitations.byOther} of ${s.recitations.total}`);
  }

  h('SCHOOLS (free text in students.school, holding pool excluded)');
  const sc = r.schools;
  console.log(`  with a school: ${sc.withSchool} · without: ${sc.withoutSchool}`);
  console.log(`  spellings: ${sc.rawDistinct} → schools after grouping: ${sc.groups.length}`);
  for (const g of sc.groups.slice(0, 30)) {
    const extra = g.variants.length > 1 ? `   ← ${g.variants.length} spellings` : '';
    console.log(`  ${String(g.students).padStart(4)}  ${g.label}${extra}`);
  }
  if (sc.groups.length > 30) console.log(`  … ${sc.groups.length - 30} more in the schools CSV`);

  h('PUSH REACH (active users with an FCM token)');
  r.push.forEach((p) => console.log(`  ${p.role.padEnd(12)} ${String(p.with_token).padStart(5)} / ${p.users}`));

  if (r.warnings.length) {
    h('WARNINGS');
    r.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }
  console.log('');
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeSchoolsCsv(r: Report, file: string): void {
  const header = ['المدرسة (الأكثر تكراراً)', 'عدد الطلاب', 'عدد طرق الكتابة', 'كل طرق الكتابة (العدد)'];
  const rows = r.schools.groups.map((g) => [
    g.label,
    g.students,
    g.variants.length,
    g.variants.map((v) => `${v.raw} (${v.students})`).join(' | '),
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  fs.writeFileSync(file, '\uFEFF' + body + '\r\n', 'utf8');
}

export function writeStudentsCsv(r: Report, file: string): void {
  if (!r.active) return;
  const header = [
    'الأستاذ', 'الطالب', 'اسم الأب', 'بداية القياس',
    'جلسات حلقته', 'حاضر', 'متأخر', 'غائب', 'غير مسجّل',
    `جلسات آخر ${CONFIG.windowDays} يوم`, 'حضر منها', 'التصنيف',
    'غياب متتالي الآن', 'تنبيه', 'آخر حضور',
  ];
  const rows = r.active.students.map((s) => [
    s.instructor, s.student, s.father, s.joined,
    s.sessions, s.present, s.late, s.absent, s.unmarked,
    s.win_sessions, s.win_attended, CLASS_AR[s.classification],
    s.absent_streak, s.alert ? 'نعم' : '', s.last_attended ?? '',
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  fs.writeFileSync(file, '﻿' + body + '\r\n', 'utf8'); // BOM → Excel reads Arabic
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

export function runIdNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function databaseUrl(): string {
  const url = process.env.PREFLIGHT_DATABASE_URL;
  if (!url) throw new Abort('PREFLIGHT_DATABASE_URL is not set.');
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Abort('PREFLIGHT_DATABASE_URL is not a postgres connection string.');
  if (/railway\.internal/.test(url)) throw new Abort('Internal Railway host — use DATABASE_PUBLIC_URL.');
  return url;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Abort(`This script takes no arguments (got "${process.argv.slice(2).join(' ')}").`);
  const url = databaseUrl();
  console.log(`Target: ${url.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@')}`);

  // Loaded lazily so the module can be imported (tests) without a generated client.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: Client } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new Client({ datasources: { db: { url } } });
  try {
    const report = await collect(prismaDb(prisma), { migrationsDir: path.resolve('prisma', 'migrations') });
    printReport(report);
    const runId = runIdNow();
    const csv = path.resolve('exports', `preflight-attendance-${runId}.csv`);
    writeStudentsCsv(report, csv);
    if (report.active) console.log(`Per-student preview: ${csv}`);
    const schoolsCsv = path.resolve('exports', `preflight-schools-${runId}.csv`);
    writeSchoolsCsv(report, schoolsCsv);
    console.log(`Schools: ${schoolsCsv}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    if (err instanceof Abort) console.error(`\n✗ ABORT: ${err.message}\n  Nothing was read or written.`);
    else {
      console.error('\n✗ FAILED — read-only transaction rolled back; nothing was written.');
      console.error(err);
    }
    process.exit(1);
  });
}
