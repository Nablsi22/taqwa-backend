/* eslint-disable no-console */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * scripts/winter-2026-split.ts
 *
 * بدء الدورة الشتوية 2026-2027 بأثر رجعي من السبت 2026-09-19.
 *
 * What it does — ONE transaction, all-or-nothing:
 *
 *   1. Courses   "summer-2026" is closed on 2026-09-18 and the winter course
 *                becomes the active course from 2026-09-19. The winter course
 *                is created if missing, or reused if it was already created
 *                from the admin "إدارة الدورات" screen.
 *
 *   2. Moves     Every recitation / hadith / points row whose real date is on
 *                or after 2026-09-19 belongs to winter; everything dated
 *                before stays in summer. The real date of a row is:
 *                  recitations ............ recitations.date
 *                  points (RECITATION) .... the source recitation's date
 *                  points (ATTENDANCE) .... the attendance day
 *                  hadith + its points .... hadith created_at, Asia/Damascus
 *                  points (MANUAL, other) . created_at, Asia/Damascus
 *                A recitation and the points it produced therefore always
 *                land in the same course. Rows of older archived courses
 *                (winter-2025-2026) are never read for moving.
 *
 *   3. Carry-over The students in EXEMPT_STUDENTS keep their balance: each
 *                gets ONE points_log row in the winter course equal to their
 *                final summer balance (source_type = TERM_CARRYOVER, dated
 *                2026-09-19 00:00 Damascus). Summer rows are never edited or
 *                deleted — the summer course stays a frozen archive.
 *
 * Safety contract
 *   • DRY RUN is the default and runs in a READ ONLY transaction.
 *   • --apply requires --confirm=<fingerprint> printed by the dry run. The
 *     plan is rebuilt under table locks and must hash to the same value, so
 *     nothing that was not reviewed can be written.
 *   • Every overwritten value is snapshotted into term_backfill_audit (the
 *     ledger created by the 2026-09-05 migration) and into
 *     _backups/winter-split-<runId>.json before anything changes.
 *   • The freeze_term_id triggers are disabled only inside the transaction
 *     and re-enabled before COMMIT — DDL is transactional in PostgreSQL, so
 *     no other session can ever observe them disabled.
 *   • Post-conditions are verified before COMMIT; any failure rolls back.
 *   • Idempotent: running --apply again after success is a no-op.
 *   • --rollback=<runId> reverses one run from the audit ledger.
 *
 * Usage (PowerShell, from the backend folder):
 *   $env:SPLIT_DATABASE_URL = '<Railway → Postgres → DATABASE_PUBLIC_URL>'
 *   npx ts-node --transpile-only scripts/winter-2026-split.ts
 *   npx ts-node --transpile-only scripts/winter-2026-split.ts --apply --confirm=<fingerprint>
 *   npx ts-node --transpile-only scripts/winter-2026-split.ts --rollback=<runId>
 *   Optional: --admin=<username>  (only needed when several ADMIN users exist)
 *
 * References
 *   ALTER TABLE … DISABLE TRIGGER  https://www.postgresql.org/docs/current/sql-altertable.html
 *   LOCK / lock modes              https://www.postgresql.org/docs/current/explicit-locking.html
 *   AT TIME ZONE                   https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-ZONECONVERT
 *   Read-only transactions         https://www.postgresql.org/docs/current/sql-set-transaction.html
 *   Prisma interactive tx          https://www.prisma.io/docs/orm/prisma-client/queries/transactions#interactive-transactions
 *   Prisma raw queries             https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

export const CONFIG = {
  /** First day of the winter course (Damascus calendar day). */
  cutoffDate: '2026-09-19',
  /** Last day of the summer course. */
  summerEndDate: '2026-09-18',
  /** The mosque's calendar. Syria is on permanent UTC+03:00. */
  localTimeZone: 'Asia/Damascus',
  /** Prisma writes DateTime as UTC into `timestamp(3)` columns. */
  storedTimeZone: 'UTC',
  summerTermName: 'summer-2026',
  winterTerm: { name: 'winter-2026-2027', nameAr: 'الدورة الشتوية 2026-2027' },
  carryover: {
    sourceType: 'TERM_CARRYOVER',
    categoryName: 'Term Carry-over',
    categoryNameAr: 'رصيد مرحّل من الدورة السابقة',
    description: 'رصيد مرحّل من الدورة الصيفية 2026',
    /** 2026-09-19 00:00 Asia/Damascus, stored as UTC like every Prisma row. */
    createdAtUtc: '2026-09-18 21:00:00',
  },
  auditTagPrefix: 'winter_2026_split',
  /** [table, trigger] pairs created by the 2026-09-05 migration. */
  freezeTriggers: [
    ['recitations', 'recitations_freeze_term_id'],
    ['hadith_recitations', 'hadith_recitations_freeze_term_id'],
    ['points_log', 'points_log_freeze_term_id'],
  ] as ReadonlyArray<readonly [string, string]>,
  /** Tables whose term_id this script may move. Never interpolate anything else. */
  movableTables: ['recitations', 'hadith_recitations', 'points_log'] as const,
  /** points_log.amount is DECIMAL(7,3). */
  maxAmount: 9999.999,
  txTimeoutMs: 180_000,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Students whose balance is NOT reset (as sent by the admin, 2026-10-13).
//
//   input  — the name exactly as it was sent
//   name   — students.full_name as stored in the database
//   father — students.father_name, used to make the match unambiguous
//
// `name` / `father` were taken from exports/student-full-report-2026-08-21.
// Where `input` and `name` differ only by spelling, the dry run flags the row
// as a correction so it is confirmed by a human before --apply.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExemptStudent {
  readonly input: string;
  readonly name: string;
  readonly father: string;
  /** Balance to carry instead of the computed summer balance. */
  readonly fixedBalance?: number;
  /**
   * Points already spent from the summer balance. Without `fixedBalance` the
   * carry-over is (summer balance − spent); with it, only a sanity check.
   */
  readonly spent?: number;
}

export const EXEMPT_STUDENTS: readonly ExemptStudent[] = [
  { input: 'بشر الحسن', name: 'بشر الحسن', father: 'محمد' },
  { input: 'ورد خضري', name: 'ورد خضري', father: 'وائل' },
  { input: 'رديف الجمل', name: 'رديف الجمل', father: 'حيان' },
  { input: 'برهان ابو شعر', name: 'برهان ابو شعر', father: 'عمر' },
  { input: 'آدم قولي', name: 'آدم قولي', father: 'عمار' },
  { input: 'آدم جاويش', name: 'آدم جاويش', father: 'باسم' },
  { input: 'ليث عرموش', name: 'ليث عرموش', father: 'مؤيد' },
  { input: 'قيس عرموش', name: 'قيس عرموش', father: 'مؤيد' },
  { input: 'كرم معلم', name: 'كرم المعلم', father: 'سعيد' },
  { input: 'معتز عجلاني', name: 'معتز عجلاني', father: 'بلال' },
  { input: 'محمد زين المحمد', name: 'محمد زين المحمد', father: 'بكر' },
  { input: 'ريان المحمد', name: 'ريان المحمد', father: 'بكر' },
  { input: 'احمد جاد العجم', name: 'أحمد جاد عجم', father: 'عبد الرحمن عجم' },
  { input: 'حمزة خضير', name: 'حمزة خضير', father: 'رضوان' },
  { input: 'محمد المحيميد', name: 'محمد المحيميد', father: 'عناد' },
  { input: 'صالح الحمود', name: 'صالح الحمود', father: 'عبد الكريم' },
  { input: 'عبد الحمن الاصيل', name: 'عبد الرحمن الأصيل', father: 'عبدالمجيد' },
  { input: 'محمد سعيد البيرملي', name: 'محمد سعيد البيرملي', father: 'ياسين' },
  { input: 'هاني النمر', name: 'هاني النمر', father: 'أحمد' },
  { input: 'عبد الرحمن الكردي', name: 'عبد الرحمن الكردي', father: 'محمد مازن' },
  { input: 'زيد قطب', name: 'زيد قطب', father: 'بشير' },
  { input: 'عبد الرحمن العبيد', name: 'عبدالرحمن العبيد', father: 'أحمد' },
  { input: 'عمر عقلة', name: 'عمر العقلة', father: 'أحمد' },
  { input: 'امير الشعار', name: 'أمير الشعار', father: 'معاذ' },
  { input: 'حمزة الشعار', name: 'حمزة الشعار', father: 'معاذ' },
  { input: 'ليث حسن', name: 'ليث حسن', father: 'محمد' },
  { input: 'محمد قلفا', name: 'محمد قلفا', father: 'راكان' },
  { input: 'جواد عطفة', name: 'جواد عطفة', father: 'علاء' },
  { input: 'نور الدين السعودي', name: 'نور الدين سعودي', father: 'هادي' },
  { input: 'أنس عبد الوهاب', name: 'أنس عبد الوهاب', father: 'كمال' },
  { input: 'براء الغشوف', name: 'براء الخشوف', father: 'إبراهيم' },
  { input: 'قصي الشعار', name: 'قصي الشعار', father: 'عامر' },
  // "كنان حمزة صرف 140 نقطة" — carries his exact summer balance minus 140
  // (confirmed by the admin 2026-10-13: 231.017 − 140 = 91.017, not a rounded 90).
  { input: 'كنان حمزة', name: 'كنان حمزة', father: 'عمر', spent: 140 },
  { input: 'احمد حيدر', name: 'أحمد حيدر', father: 'صلاح الدين' },
  { input: 'احمد المحيميد', name: 'أحمد المحيميد', father: 'عبد المعطي' },
  { input: 'سليمان المصري', name: 'سليمان مصري', father: 'محمد مسلّم' },
  { input: 'ماهر محمود', name: 'ماهر محمود', father: 'عدنان' },
  { input: 'عبد الرحمن الصالح', name: 'عبد الرحمن الصالح', father: 'حمود' },
  { input: 'رضا العباس', name: 'رضا العباس', father: '.' },
  { input: 'حمزة العلي', name: 'حمزة العلي', father: 'علي' },
  { input: 'ميار خلوف', name: 'ميار خلوف', father: 'مازن' },
  { input: 'نجم قصيلي', name: 'نجم قصيلي', father: 'بشار' },
  { input: 'آدم عبد الله', name: 'آدم عبدالله', father: 'بكري' },
  { input: 'ينال شكري', name: 'ينال شاكر', father: 'سمير' },
  { input: 'عمرو البرغلي', name: 'عمرو البرغلي', father: 'ياسين' },
  { input: 'محمد محيميد', name: 'محمد محيميد', father: 'عبد المعطي' },
  { input: 'وائل ببلي', name: 'وائل ببيلي', father: 'وائل' },
  { input: 'احمد جغصي', name: 'أحمد جغصي', father: '........' },
  { input: 'احمد زيدان', name: 'أحمد زيدان', father: 'زاهر' },
  { input: 'محمد المحمود', name: 'محمد المحمود', father: 'عدنان' },
  { input: 'رائد العلي', name: 'رائد العلي', father: 'يوسف' },
];

// ═══════════════════════════════════════════════════════════════════════════
// Database port — the script talks to PostgreSQL only through this, so the
// exact same SQL runs on Prisma in production and on node-postgres in tests.
// Every parameter is a string (or null) and every value is cast in SQL, so
// both drivers bind and return identical types.
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

/** A deliberate stop. Nothing has been written when this is thrown. */
export class Abort extends Error {}

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface TermRow extends Row {
  id: number;
  name: string;
  name_ar: string;
  start_date: string;
  end_date: string | null;
  is_active: boolean;
}

interface StudentRow extends Row {
  id: string;
  full_name: string;
  father_name: string;
}

interface BalanceRow extends Row {
  student_id: string;
  full_name: string;
  father_name: string;
  summer_before: string;
  winter_before: string;
  summer_after: string;
  winter_earned: string;
}

interface MoveSummaryRow extends Row {
  tbl: string;
  cur: string;
  tgt: string;
  n: number;
  pts: string;
  first_day: string | null;
  last_day: string | null;
}

interface TriggerRow extends Row {
  tbl: string;
  name: string;
  enabled: string;
}

type TermOp =
  | { kind: 'close-summer'; termId: number; from: Pick<TermRow, 'is_active' | 'end_date'> }
  | { kind: 'create-winter' }
  | {
      kind: 'update-winter';
      termId: number;
      from: Pick<TermRow, 'is_active' | 'start_date' | 'end_date'>;
    };

type MatchKind = 'exact' | 'normalized' | 'corrected';

interface ExemptResolution {
  entry: ExemptStudent;
  matchKind: MatchKind;
  student: StudentRow | null;
  error: string | null;
}

interface Carryover {
  studentId: string;
  name: string;
  summerAfter: string;
  amount: string;
  status: 'insert' | 'already-carried' | 'skipped-non-positive';
  existingAmount: string | null;
}

export interface Plan {
  db: { version: string; timeZone: string };
  terms: TermRow[];
  summer: TermRow;
  winter: TermRow | null;
  termOps: TermOp[];
  moves: { summary: MoveSummaryRow[]; count: number; digest: string };
  exempt: ExemptResolution[];
  carryovers: Carryover[];
  balances: BalanceRow[];
  admin: { id: string; username: string };
  category: { id: string | null };
  triggers: TriggerRow[];
  nullTermRows: { points: number; recitations: number; hadith: number };
  warnings: string[];
  errors: string[];
  fingerprint: string;
  isNoop: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Comparison key for Arabic names: strips diacritics/tatweel, folds the
 * hamza/alef/ta-marbuta/alef-maqsura variants, and drops every non-letter
 * (spaces, dots, digits) so "عبد الله" ≡ "عبدالله" and "." ≡ "".
 */
export function normalizeArabic(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^ء-ي]/g, '');
}

const toNum = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
const fmt = (v: string | number): string => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
};

export function runIdNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file: string, header: string[], rows: unknown[][]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  fs.writeFileSync(file, '﻿' + body + '\r\n', 'utf8'); // BOM → Excel reads Arabic
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL — the classification of every row in the summer/winter courses
//
//   $1 summer_id  $2 winter_id (nullable)  $3 cutoff date
//   $4 local tz   $5 stored tz             $6 carry-over source_type
// ═══════════════════════════════════════════════════════════════════════════

const CLASSIFIED_CTE = `
WITH cfg AS (
  SELECT $1::int  AS summer_id,
         $2::int  AS winter_id,
         $3::date AS cutoff,
         $4::text AS local_tz,
         $5::text AS stored_tz,
         $6::text AS carry_type
),
src AS (
  SELECT 'recitations'::text AS tbl, r.id AS row_id, r.term_id,
         r.date AS biz_date, NULL::numeric AS amount, r.student_id
    FROM recitations r CROSS JOIN cfg c
   WHERE r.term_id IN (c.summer_id, c.winter_id)
  UNION ALL
  SELECT 'hadith_recitations', h.id, h.term_id,
         ((h.created_at AT TIME ZONE c.stored_tz) AT TIME ZONE c.local_tz)::date,
         NULL::numeric, h.student_id
    FROM hadith_recitations h CROSS JOIN cfg c
   WHERE h.term_id IN (c.summer_id, c.winter_id)
  UNION ALL
  SELECT 'points_log', p.id, p.term_id,
         CASE
           WHEN p.source_type = 'RECITATION' AND r.id IS NOT NULL THEN r.date
           WHEN p.source_type = 'ATTENDANCE' AND a.id IS NOT NULL THEN a.date
           WHEN p.source_type = 'HADITH_RECITATION' AND h.id IS NOT NULL
             THEN ((h.created_at AT TIME ZONE c.stored_tz) AT TIME ZONE c.local_tz)::date
           ELSE ((p.created_at AT TIME ZONE c.stored_tz) AT TIME ZONE c.local_tz)::date
         END,
         p.amount, p.student_id
    FROM points_log p
    CROSS JOIN cfg c
    LEFT JOIN recitations r
           ON p.source_type = 'RECITATION' AND r.id = p.source_id
    LEFT JOIN attendance a
           ON p.source_type = 'ATTENDANCE' AND a.id = p.source_id
    LEFT JOIN hadith_recitations h
           ON p.source_type = 'HADITH_RECITATION' AND h.id = p.source_id
   WHERE p.term_id IN (c.summer_id, c.winter_id)
     AND p.source_type IS DISTINCT FROM c.carry_type
),
classified AS (
  SELECT s.tbl, s.row_id, s.term_id, s.biz_date, s.amount, s.student_id,
         CASE WHEN s.term_id = c.summer_id THEN 'summer' ELSE 'winter' END AS cur,
         CASE WHEN s.biz_date >= c.cutoff  THEN 'winter' ELSE 'summer' END AS tgt
    FROM src s CROSS JOIN cfg c
)`;

function cteParams(summerId: number, winterId: number | null): Param[] {
  return [
    String(summerId),
    winterId == null ? null : String(winterId),
    CONFIG.cutoffDate,
    CONFIG.localTimeZone,
    CONFIG.storedTimeZone,
    CONFIG.carryover.sourceType,
  ];
}

async function moveDigest(tx: Tx, summerId: number, winterId: number | null) {
  const [row] = await tx.query<{ n: number; digest: string } & Row>(
    `${CLASSIFIED_CTE}
     SELECT count(*)::int AS n,
            md5(COALESCE(string_agg(tbl || ':' || row_id || ':' || cur || '>' || tgt, ','
                                    ORDER BY tbl, row_id), '')) AS digest
       FROM classified
      WHERE cur <> tgt`,
    ...cteParams(summerId, winterId),
  );
  return row;
}

async function invariants(tx: Tx, summerId: number, winterId: number | null) {
  const [row] = await tx.query<
    { pts_n: number; pts_sum: string; rec_n: number; had_n: number } & Row
  >(
    `SELECT (SELECT count(*) FROM points_log
              WHERE term_id IN ($1::int, $2::int)
                AND source_type IS DISTINCT FROM $3)::int            AS pts_n,
            (SELECT COALESCE(sum(amount), 0) FROM points_log
              WHERE term_id IN ($1::int, $2::int)
                AND source_type IS DISTINCT FROM $3)::text           AS pts_sum,
            (SELECT count(*) FROM recitations
              WHERE term_id IN ($1::int, $2::int))::int              AS rec_n,
            (SELECT count(*) FROM hadith_recitations
              WHERE term_id IN ($1::int, $2::int))::int              AS had_n`,
    String(summerId),
    winterId == null ? null : String(winterId),
    CONFIG.carryover.sourceType,
  );
  return row;
}

async function loadTriggers(tx: Tx): Promise<TriggerRow[]> {
  return tx.query<TriggerRow>(
    `SELECT c.relname::text AS tbl, t.tgname::text AS name, t.tgenabled::text AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND t.tgname IN ('recitations_freeze_term_id',
                         'hadith_recitations_freeze_term_id',
                         'points_log_freeze_term_id')
      ORDER BY 1`,
  );
}

async function setFreezeTriggers(tx: Tx, triggers: TriggerRow[], enable: boolean) {
  for (const [table, trigger] of CONFIG.freezeTriggers) {
    if (!triggers.some((t) => t.tbl === table && t.name === trigger)) continue;
    // Identifiers come from CONFIG constants only — never from input.
    await tx.exec(`ALTER TABLE "${table}" ${enable ? 'ENABLE' : 'DISABLE'} TRIGGER "${trigger}"`);
  }
}

async function ensureAuditTable(tx: Tx) {
  // Same shape as prisma/migrations/20260905000000_course_isolation_and_verse_range.
  await tx.exec(`
    CREATE TABLE IF NOT EXISTS "term_backfill_audit" (
      "id"          BIGSERIAL    PRIMARY KEY,
      "migration"   TEXT         NOT NULL,
      "table_name"  TEXT         NOT NULL,
      "row_id"      TEXT         NOT NULL,
      "column_name" TEXT         NOT NULL,
      "old_value"   TEXT,
      "new_value"   TEXT,
      "captured_at" TIMESTAMPTZ  NOT NULL DEFAULT now()
    )`);
  await tx.exec(`
    CREATE INDEX IF NOT EXISTS "term_backfill_audit_lookup_idx"
      ON "term_backfill_audit" ("migration", "table_name", "row_id")`);
}

async function audit(
  tx: Tx,
  tag: string,
  table: string,
  rowId: string,
  column: string,
  oldValue: string | null,
  newValue: string | null,
) {
  await tx.exec(
    `INSERT INTO term_backfill_audit (migration, table_name, row_id, column_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    tag,
    table,
    rowId,
    column,
    oldValue,
    newValue,
  );
}

async function lockTables(tx: Tx) {
  await tx.exec(`SET LOCAL lock_timeout = '15s'`);
  await tx.exec(`SET LOCAL statement_timeout = '120s'`);
  // SHARE ROW EXCLUSIVE blocks every concurrent INSERT/UPDATE/DELETE on these
  // tables for the few seconds the script runs, while SELECTs keep working.
  await tx.exec(
    `LOCK TABLE terms, recitations, hadith_recitations, points_log, point_categories
       IN SHARE ROW EXCLUSIVE MODE`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Plan — read-only; identical in dry run and apply
// ═══════════════════════════════════════════════════════════════════════════

export async function buildPlan(tx: Tx, opts: { adminUsername?: string } = {}): Promise<Plan> {
  const warnings: string[] = [];
  const errors: string[] = [];

  // ── Server sanity ─────────────────────────────────────────────────────
  const [server] = await tx.query<{ version: string; tz: string; probe: string } & Row>(
    `SELECT current_setting('server_version') AS version,
            current_setting('TimeZone')       AS tz,
            ((TIMESTAMP '2026-09-18 21:00:00' AT TIME ZONE $1) AT TIME ZONE $2)::text AS probe`,
    CONFIG.storedTimeZone,
    CONFIG.localTimeZone,
  );
  if (server.probe !== '2026-09-19 00:00:00') {
    errors.push(
      `Time-zone probe failed: 2026-09-18 21:00 UTC → ${server.probe} in ${CONFIG.localTimeZone} ` +
        `(expected 2026-09-19 00:00:00).`,
    );
  }
  if (!/^(UTC|Etc\/UTC|GMT|Etc\/GMT|UCT|Universal|Zulu)$/i.test(server.tz)) {
    warnings.push(
      `Database TimeZone is "${server.tz}", not UTC. Rows whose created_at came from a DB ` +
        `default may be shifted — check the rows dated 2026-09-18 / 2026-09-19 in the CSV.`,
    );
  }

  // ── Courses ───────────────────────────────────────────────────────────
  const terms = await tx.query<TermRow>(
    `SELECT id::int AS id, name, name_ar, start_date::text AS start_date,
            end_date::text AS end_date, is_active
       FROM terms ORDER BY start_date, id`,
  );
  const summer = terms.find((t) => t.name === CONFIG.summerTermName);
  if (!summer) {
    throw new Abort(
      `Course "${CONFIG.summerTermName}" not found. Courses: ` +
        terms.map((t) => `${t.id}:${t.name}`).join(', '),
    );
  }
  if (summer.start_date >= CONFIG.cutoffDate) {
    throw new Abort(`Summer starts ${summer.start_date}, not before ${CONFIG.cutoffDate}.`);
  }

  const winterCandidates = terms.filter(
    (t) => t.id !== summer.id && t.start_date > summer.start_date,
  );
  if (winterCandidates.length > 1) {
    throw new Abort(
      `More than one course starts after summer: ` +
        winterCandidates.map((t) => `${t.id}:${t.name}`).join(', ') +
        ` — resolve manually first.`,
    );
  }
  const winter = winterCandidates[0] ?? null;
  if (winter && winter.name !== CONFIG.winterTerm.name) {
    warnings.push(
      `Reusing the existing course "${winter.name_ar}" (id ${winter.id}, "${winter.name}") as the winter course.`,
    );
  }
  const active = terms.filter((t) => t.is_active);
  for (const t of active) {
    if (t.id !== summer.id && t.id !== winter?.id) {
      throw new Abort(`Unexpected active course ${t.id}:${t.name} — expected summer or winter.`);
    }
  }

  const termOps: TermOp[] = [];
  if (summer.is_active || summer.end_date !== CONFIG.summerEndDate) {
    termOps.push({
      kind: 'close-summer',
      termId: summer.id,
      from: { is_active: summer.is_active, end_date: summer.end_date },
    });
  }
  if (!winter) {
    termOps.push({ kind: 'create-winter' });
  } else if (
    !winter.is_active ||
    winter.start_date !== CONFIG.cutoffDate ||
    winter.end_date !== null
  ) {
    termOps.push({
      kind: 'update-winter',
      termId: winter.id,
      from: {
        is_active: winter.is_active,
        start_date: winter.start_date,
        end_date: winter.end_date,
      },
    });
  }

  // ── Moves ─────────────────────────────────────────────────────────────
  const params = cteParams(summer.id, winter?.id ?? null);
  const summary = await tx.query<MoveSummaryRow>(
    `${CLASSIFIED_CTE}
     SELECT tbl, cur, tgt, count(*)::int AS n,
            COALESCE(sum(amount), 0)::text AS pts,
            min(biz_date)::text AS first_day, max(biz_date)::text AS last_day
       FROM classified
      GROUP BY tbl, cur, tgt
      ORDER BY tbl, cur, tgt`,
    ...params,
  );
  const digest = await moveDigest(tx, summer.id, winter?.id ?? null);

  // recitations_verse_range_chk (2026-09-05) is NOT VALID, so it is only
  // re-checked when a row is updated. A row written after the cutoff of that
  // migration without a verse range would make the move fail mid-transaction;
  // report it here instead.
  const [rangeChk] = await tx.query<{ present: boolean; bad: number } & Row>(
    `${CLASSIFIED_CTE}
     SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recitations_verse_range_chk') AS present,
            (SELECT count(*) FROM classified x JOIN recitations r ON r.id = x.row_id
              WHERE x.tbl = 'recitations' AND x.cur <> x.tgt
                AND r.created_at >= TIMESTAMP '2026-09-05 00:00:00'
                AND r.rating <> 'MAQRAA'
                AND NOT COALESCE(r."startSurah" BETWEEN 1 AND 114
                             AND r."endSurah" = r."startSurah"
                             AND r."startAya" >= 1
                             AND r."endAya" >= r."startAya", false))::int AS bad`,
    ...params,
  );
  if (rangeChk.present && rangeChk.bad > 0) {
    errors.push(
      `${rangeChk.bad} recitation(s) to move were written after 2026-09-05 without a valid verse range; ` +
        `recitations_verse_range_chk would reject the move.`,
    );
  }

  const [nulls] = await tx.query<{ p: number; r: number; h: number } & Row>(
    `SELECT (SELECT count(*) FROM points_log         WHERE term_id IS NULL)::int AS p,
            (SELECT count(*) FROM recitations        WHERE term_id IS NULL)::int AS r,
            (SELECT count(*) FROM hadith_recitations WHERE term_id IS NULL)::int AS h`,
  );
  if (nulls.p + nulls.r + nulls.h > 0) {
    warnings.push(
      `Rows without a course (left untouched): points=${nulls.p}, recitations=${nulls.r}, hadith=${nulls.h}.`,
    );
  }

  // ── Balances per student (before / after the move) ───────────────────
  const balances = await tx.query<BalanceRow>(
    `${CLASSIFIED_CTE}
     SELECT s.id AS student_id, s.full_name, s.father_name,
            COALESCE(sum(c.amount) FILTER (WHERE c.cur = 'summer'), 0)::text AS summer_before,
            COALESCE(sum(c.amount) FILTER (WHERE c.cur = 'winter'), 0)::text AS winter_before,
            COALESCE(sum(c.amount) FILTER (WHERE c.tgt = 'summer'), 0)::text AS summer_after,
            COALESCE(sum(c.amount) FILTER (WHERE c.tgt = 'winter'), 0)::text AS winter_earned
       FROM students s
       LEFT JOIN classified c ON c.tbl = 'points_log' AND c.student_id = s.id
      WHERE s.deleted_at IS NULL
      GROUP BY s.id, s.full_name, s.father_name
      ORDER BY s.full_name, s.father_name`,
    ...params,
  );
  const balanceById = new Map(balances.map((b) => [b.student_id, b]));

  // ── Exempt students ───────────────────────────────────────────────────
  const students = await tx.query<StudentRow>(
    `SELECT id, full_name, father_name FROM students WHERE deleted_at IS NULL`,
  );
  const byName = new Map<string, StudentRow[]>();
  for (const s of students) {
    const k = normalizeArabic(s.full_name);
    byName.set(k, [...(byName.get(k) ?? []), s]);
  }

  const exempt: ExemptResolution[] = EXEMPT_STUDENTS.map((entry) => {
    const matchKind: MatchKind =
      entry.input.trim() === entry.name.trim()
        ? 'exact'
        : normalizeArabic(entry.input) === normalizeArabic(entry.name)
          ? 'normalized'
          : 'corrected';
    const sameName = byName.get(normalizeArabic(entry.name)) ?? [];
    const hits = sameName.filter(
      (s) => normalizeArabic(s.father_name) === normalizeArabic(entry.father),
    );
    let error: string | null = null;
    if (sameName.length === 0) error = 'no active student with this name';
    else if (hits.length === 0)
      error = `name found but father differs (${sameName.map((s) => s.father_name).join(' / ')})`;
    else if (hits.length > 1) error = `${hits.length} active students share this name and father`;
    return { entry, matchKind, student: hits.length === 1 ? hits[0] : null, error };
  });

  const seen = new Map<string, string>();
  for (const r of exempt) {
    if (r.error) errors.push(`Exempt "${r.entry.input}" → "${r.entry.name}": ${r.error}.`);
    if (r.student) {
      const prev = seen.get(r.student.id);
      if (prev) errors.push(`"${prev}" and "${r.entry.input}" resolve to the same student.`);
      seen.set(r.student.id, r.entry.input);
    }
  }

  // ── Carry-overs ───────────────────────────────────────────────────────
  const existing = new Map<string, string>();
  if (winter) {
    const rows = await tx.query<{ student_id: string; amount: string } & Row>(
      `SELECT student_id, amount::text AS amount
         FROM points_log WHERE term_id = $1::int AND source_type = $2`,
      String(winter.id),
      CONFIG.carryover.sourceType,
    );
    for (const r of rows) {
      if (existing.has(r.student_id)) {
        errors.push(`Student ${r.student_id} already has more than one carry-over row in winter.`);
      }
      existing.set(r.student_id, r.amount);
    }
  }

  const carryovers: Carryover[] = [];
  for (const r of exempt) {
    if (!r.student) continue;
    const bal = balanceById.get(r.student.id);
    const summerAfter = bal?.summer_after ?? '0';
    // Amounts carry at most 3 decimals (DECIMAL(7,3)); round away float noise.
    const amountNum =
      Math.round((r.entry.fixedBalance ?? toNum(summerAfter) - (r.entry.spent ?? 0)) * 1000) / 1000;
    const amount = amountNum.toFixed(3);

    if (r.entry.fixedBalance != null && r.entry.spent != null) {
      const implied = toNum(summerAfter) - r.entry.spent;
      if (Math.abs(implied - r.entry.fixedBalance) > 0.5) {
        warnings.push(
          `${r.entry.name}: summer balance ${fmt(summerAfter)} − spent ${r.entry.spent} = ` +
            `${fmt(implied)}, but the stated remainder is ${r.entry.fixedBalance}. ` +
            `${r.entry.fixedBalance} will be carried — confirm.`,
        );
      }
    }
    if (amountNum > CONFIG.maxAmount) {
      errors.push(`${r.entry.name}: carry-over ${amount} exceeds DECIMAL(7,3).`);
    }

    let status: Carryover['status'] = 'insert';
    if (existing.has(r.student.id)) status = 'already-carried';
    else if (amountNum <= 0) status = 'skipped-non-positive';
    if (status === 'skipped-non-positive') {
      warnings.push(`${r.entry.name}: summer balance is ${fmt(summerAfter)} — nothing to carry.`);
    }
    if (status === 'already-carried' && toNum(existing.get(r.student.id)) !== amountNum) {
      warnings.push(
        `${r.entry.name}: already carried ${fmt(existing.get(r.student.id)!)} (plan says ${fmt(amount)}) — left as is.`,
      );
    }
    carryovers.push({
      studentId: r.student.id,
      name: r.entry.name,
      summerAfter,
      amount,
      status,
      existingAmount: existing.get(r.student.id) ?? null,
    });
  }
  // Carry-over rows in winter for students NOT in the list are suspicious.
  for (const [sid] of existing) {
    if (!carryovers.some((c) => c.studentId === sid)) {
      warnings.push(`Student ${sid} has a carry-over row in winter but is not in EXEMPT_STUDENTS.`);
    }
  }

  // ── Admin (awarded_by) and category ──────────────────────────────────
  const admins = await tx.query<{ id: string; username: string } & Row>(
    `SELECT id, username FROM users
      WHERE role = 'ADMIN' AND is_active AND deleted_at IS NULL
      ORDER BY created_at, id`,
  );
  let admin = admins[0];
  if (opts.adminUsername) {
    admin = admins.find((a) => a.username === opts.adminUsername)!;
    if (!admin) errors.push(`--admin=${opts.adminUsername} is not an active ADMIN user.`);
  } else if (admins.length !== 1) {
    errors.push(
      `${admins.length} active ADMIN users (${admins.map((a) => a.username).join(', ')}) — ` +
        `pass --admin=<username> to choose who the carry-over is awarded by.`,
    );
  }

  const cats = await tx.query<{ id: string } & Row>(
    `SELECT id FROM point_categories WHERE name = $1 AND type = 'EARN'
      ORDER BY created_at, id LIMIT 2`,
    CONFIG.carryover.categoryName,
  );
  if (cats.length > 1) warnings.push(`Several "${CONFIG.carryover.categoryName}" categories — using the oldest.`);

  const triggers = await loadTriggers(tx);
  for (const t of triggers) {
    if (t.enabled !== 'O') warnings.push(`Trigger ${t.name} is currently "${t.enabled}" (not enabled).`);
  }

  // ── Fingerprint: everything that would be written ────────────────────
  const inserts = carryovers.filter((c) => c.status === 'insert');
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        termOps: termOps.map((o) => o.kind),
        moves: [digest.n, digest.digest],
        carry: inserts.map((c) => [c.studentId, c.amount]),
        createCategory: cats.length === 0 && inserts.length > 0,
      }),
    )
    .digest('hex')
    .slice(0, 12);

  return {
    db: { version: server.version, timeZone: server.tz },
    terms,
    summer,
    winter,
    termOps,
    moves: { summary, count: digest.n, digest: digest.digest },
    exempt,
    carryovers,
    balances,
    admin: admin ?? { id: '', username: '' },
    category: { id: cats[0]?.id ?? null },
    triggers,
    nullTermRows: { points: nulls.p, recitations: nulls.r, hadith: nulls.h },
    warnings,
    errors,
    fingerprint,
    isNoop: termOps.length === 0 && digest.n === 0 && inserts.length === 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Modes
// ═══════════════════════════════════════════════════════════════════════════

export interface RunResult {
  mode: 'dry-run' | 'apply' | 'rollback';
  runId: string;
  plan?: Plan;
  noop?: boolean;
  winterId?: number;
  messages: string[];
}

export async function dryRun(db: Db, opts: { adminUsername?: string } = {}): Promise<Plan> {
  return db.transaction(async (tx) => {
    await tx.exec(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    return buildPlan(tx, opts);
  }, CONFIG.txTimeoutMs);
}

export async function apply(
  db: Db,
  opts: { confirm: string; adminUsername?: string; runId?: string; backupDir?: string },
): Promise<RunResult> {
  const runId = opts.runId ?? runIdNow();
  const tag = `${CONFIG.auditTagPrefix}:${runId}`;
  const messages: string[] = [];

  return db.transaction(async (tx) => {
    await lockTables(tx);
    const plan = await buildPlan(tx, opts);

    if (plan.errors.length > 0) {
      throw new Abort(`Plan has ${plan.errors.length} error(s):\n  - ${plan.errors.join('\n  - ')}`);
    }
    if (plan.fingerprint !== opts.confirm) {
      throw new Abort(
        `Fingerprint mismatch: dry run said ${opts.confirm}, current plan is ${plan.fingerprint}. ` +
          `The data changed since the dry run — run the dry run again and review it.`,
      );
    }
    if (plan.isNoop) {
      messages.push('Nothing to do — the split is already applied.');
      return { mode: 'apply', runId, plan, noop: true, messages };
    }

    // ── Backup file (before any write) ─────────────────────────────────
    const backupDir = opts.backupDir ?? path.resolve('_backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const moveRows = await tx.query<{ tbl: string; row_id: string; term_id: number; tgt: string } & Row>(
      `${CLASSIFIED_CTE}
       SELECT tbl, row_id, term_id::int AS term_id, tgt FROM classified
        WHERE cur <> tgt ORDER BY tbl, row_id`,
      ...cteParams(plan.summer.id, plan.winter?.id ?? null),
    );
    fs.writeFileSync(
      path.join(backupDir, `winter-split-${runId}.json`),
      JSON.stringify(
        {
          runId,
          auditTag: tag,
          fingerprint: plan.fingerprint,
          capturedAt: new Date().toISOString(),
          terms: plan.terms,
          termOps: plan.termOps,
          moves: moveRows,
          carryovers: plan.carryovers.filter((c) => c.status === 'insert'),
        },
        null,
        2,
      ),
      'utf8',
    );

    await ensureAuditTable(tx);
    const before = await invariants(tx, plan.summer.id, plan.winter?.id ?? null);

    // ── 1. Courses ─────────────────────────────────────────────────────
    let winterId = plan.winter?.id ?? null;
    for (const op of plan.termOps) {
      if (op.kind === 'close-summer') {
        await audit(tx, tag, 'terms', String(op.termId), 'is_active', String(op.from.is_active), 'false');
        await audit(tx, tag, 'terms', String(op.termId), 'end_date', op.from.end_date, CONFIG.summerEndDate);
        await tx.exec(
          `UPDATE terms SET is_active = false, end_date = $2::date, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1::int`,
          String(op.termId),
          CONFIG.summerEndDate,
        );
      }
    }
    for (const op of plan.termOps) {
      if (op.kind === 'create-winter') {
        const [row] = await tx.query<{ id: number } & Row>(
          `INSERT INTO terms (name, name_ar, start_date, end_date, is_active, created_at, updated_at)
           VALUES ($1, $2, $3::date, NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id::int AS id`,
          CONFIG.winterTerm.name,
          CONFIG.winterTerm.nameAr,
          CONFIG.cutoffDate,
        );
        winterId = row.id;
        await audit(tx, tag, 'terms', String(winterId), '__inserted__', null, CONFIG.winterTerm.name);
      } else if (op.kind === 'update-winter') {
        await audit(tx, tag, 'terms', String(op.termId), 'is_active', String(op.from.is_active), 'true');
        await audit(tx, tag, 'terms', String(op.termId), 'start_date', op.from.start_date, CONFIG.cutoffDate);
        await audit(tx, tag, 'terms', String(op.termId), 'end_date', op.from.end_date, null);
        await tx.exec(
          `UPDATE terms SET is_active = true, start_date = $2::date, end_date = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1::int`,
          String(op.termId),
          CONFIG.cutoffDate,
        );
      }
    }
    if (winterId == null) throw new Error('Invariant: winter course id is unknown after course step.');
    messages.push(`Courses: summer ${plan.summer.id} closed ${CONFIG.summerEndDate}, winter ${winterId} active from ${CONFIG.cutoffDate}.`);

    // The plan must be unchanged now that the winter course exists.
    const recheck = await moveDigest(tx, plan.summer.id, winterId);
    if (recheck.n !== plan.moves.count || recheck.digest !== plan.moves.digest) {
      throw new Error('Invariant: move plan changed after the course step.');
    }

    // ── 2. Moves (ledger first, then updates driven by the ledger) ─────
    if (plan.moves.count > 0) {
      const logged = await tx.exec(
        `${CLASSIFIED_CTE}
         INSERT INTO term_backfill_audit (migration, table_name, row_id, column_name, old_value, new_value)
         SELECT $7, x.tbl, x.row_id, 'term_id', x.term_id::text,
                (CASE WHEN x.tgt = 'winter' THEN c.winter_id ELSE c.summer_id END)::text
           FROM classified x CROSS JOIN cfg c
          WHERE x.cur <> x.tgt`,
        ...cteParams(plan.summer.id, winterId),
        tag,
      );
      if (logged !== plan.moves.count) {
        throw new Error(`Invariant: audited ${logged} moves, planned ${plan.moves.count}.`);
      }

      await setFreezeTriggers(tx, plan.triggers, false);
      for (const table of CONFIG.movableTables) {
        const [{ n: expected }] = await tx.query<{ n: number } & Row>(
          `SELECT count(*)::int AS n FROM term_backfill_audit
            WHERE migration = $1 AND table_name = $2 AND column_name = 'term_id'`,
          tag,
          table,
        );
        const updated = await tx.exec(
          `UPDATE "${table}" t
              SET term_id = a.new_value::int
             FROM term_backfill_audit a
            WHERE a.migration = $1 AND a.table_name = $2 AND a.column_name = 'term_id'
              AND a.row_id = t.id AND t.term_id = a.old_value::int`,
          tag,
          table,
        );
        if (updated !== expected) {
          throw new Error(`Invariant: ${table} updated ${updated} rows, expected ${expected}.`);
        }
        messages.push(`Moved ${table}: ${updated}`);
      }
      await setFreezeTriggers(tx, plan.triggers, true);
    }

    // ── 3. Carry-over ──────────────────────────────────────────────────
    const inserts = plan.carryovers.filter((c) => c.status === 'insert');
    if (inserts.length > 0) {
      let categoryId = plan.category.id;
      if (!categoryId) {
        categoryId = randomUUID();
        // is_active = false keeps it out of the instructors' manual-award picker.
        await tx.exec(
          `INSERT INTO point_categories (id, name, name_ar, type, default_value, has_rating, is_active, created_at)
           VALUES ($1, $2, $3, 'EARN', 0, false, false, CURRENT_TIMESTAMP)`,
          categoryId,
          CONFIG.carryover.categoryName,
          CONFIG.carryover.categoryNameAr,
        );
        await audit(tx, tag, 'point_categories', categoryId, '__inserted__', null, CONFIG.carryover.categoryName);
      }
      for (const c of inserts) {
        const entry = EXEMPT_STUDENTS.find((e) => e.name === c.name);
        const description =
          entry?.spent != null
            ? `${CONFIG.carryover.description} (بعد صرف ${entry.spent} نقطة)`
            : CONFIG.carryover.description;
        const id = randomUUID();
        await tx.exec(
          `INSERT INTO points_log (id, student_id, category_id, amount, description, awarded_by,
                                   source_id, source_type, term_id, created_at)
           VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9::int, $10::timestamp)`,
          id,
          c.studentId,
          categoryId,
          c.amount,
          description,
          plan.admin.id,
          String(plan.summer.id),
          CONFIG.carryover.sourceType,
          String(winterId),
          CONFIG.carryover.createdAtUtc,
        );
        await audit(tx, tag, 'points_log', id, '__inserted__', null, c.amount);
      }
      messages.push(`Carry-over rows inserted: ${inserts.length}`);
    }

    // ── 4. Post-conditions (any failure → ROLLBACK) ────────────────────
    await verifyApplied(tx, plan, winterId, before);
    messages.push('Post-conditions: all passed.');
    return { mode: 'apply', runId, plan, winterId, messages };
  }, CONFIG.txTimeoutMs);
}

async function verifyApplied(
  tx: Tx,
  plan: Plan,
  winterId: number,
  before: Awaited<ReturnType<typeof invariants>>,
) {
  const fail = (msg: string): never => {
    throw new Error(`Post-condition failed: ${msg}`);
  };

  const terms = await tx.query<TermRow>(
    `SELECT id::int AS id, name, name_ar, start_date::text AS start_date,
            end_date::text AS end_date, is_active FROM terms`,
  );
  const activeIds = terms.filter((t) => t.is_active).map((t) => t.id);
  if (activeIds.length !== 1 || activeIds[0] !== winterId) fail(`active courses = [${activeIds}]`);
  const s = terms.find((t) => t.id === plan.summer.id)!;
  const w = terms.find((t) => t.id === winterId)!;
  if (s.end_date !== CONFIG.summerEndDate) fail(`summer end_date = ${s.end_date}`);
  if (w.start_date !== CONFIG.cutoffDate || w.end_date !== null) fail(`winter dates = ${w.start_date}..${w.end_date}`);

  const misplaced = await moveDigest(tx, plan.summer.id, winterId);
  if (misplaced.n !== 0) fail(`${misplaced.n} rows still in the wrong course`);

  const after = await invariants(tx, plan.summer.id, winterId);
  if (after.pts_n !== before.pts_n || toNum(after.pts_sum) !== toNum(before.pts_sum)) {
    fail(`points changed: ${before.pts_n}/${before.pts_sum} → ${after.pts_n}/${after.pts_sum}`);
  }
  if (after.rec_n !== before.rec_n || after.had_n !== before.had_n) fail('recitation/hadith counts changed');

  const [split] = await tx.query<{ rec: number; had: number } & Row>(
    `SELECT (SELECT count(*) FROM points_log p JOIN recitations r
               ON p.source_type = 'RECITATION' AND r.id = p.source_id
              WHERE p.term_id IN ($1::int, $2::int) AND p.term_id IS DISTINCT FROM r.term_id)::int AS rec,
            (SELECT count(*) FROM points_log p JOIN hadith_recitations h
               ON p.source_type = 'HADITH_RECITATION' AND h.id = p.source_id
              WHERE p.term_id IN ($1::int, $2::int) AND p.term_id IS DISTINCT FROM h.term_id)::int AS had`,
    String(plan.summer.id),
    String(winterId),
  );
  if (split.rec + split.had > 0) fail(`points split from their source row: rec=${split.rec}, had=${split.had}`);

  const carried = await tx.query<{ student_id: string; n: number; amount: string } & Row>(
    `SELECT student_id, count(*)::int AS n, sum(amount)::text AS amount
       FROM points_log WHERE term_id = $1::int AND source_type = $2
      GROUP BY student_id`,
    String(winterId),
    CONFIG.carryover.sourceType,
  );
  const carriedBy = new Map(carried.map((c) => [c.student_id, c]));
  for (const c of plan.carryovers) {
    if (c.status === 'skipped-non-positive') continue;
    const got = carriedBy.get(c.studentId);
    const want = c.status === 'insert' ? c.amount : c.existingAmount;
    if (!got || got.n !== 1 || toNum(got.amount) !== toNum(want)) {
      fail(`carry-over for ${c.name}: got ${got?.n ?? 0} row(s) / ${got?.amount}, want 1 / ${want}`);
    }
    const [{ total }] = await tx.query<{ total: string } & Row>(
      `SELECT COALESCE(sum(amount), 0)::text AS total FROM points_log
        WHERE term_id = $1::int AND student_id = $2`,
      String(plan.summer.id),
      c.studentId,
    );
    if (toNum(total) !== toNum(c.summerAfter)) fail(`summer balance of ${c.name} is ${total}, planned ${c.summerAfter}`);
  }

  for (const t of await loadTriggers(tx)) {
    if (t.enabled !== 'O') fail(`trigger ${t.name} is "${t.enabled}" after the run`);
  }
}

// ── Rollback ───────────────────────────────────────────────────────────────

export async function rollback(db: Db, runId: string): Promise<RunResult> {
  const tag = `${CONFIG.auditTagPrefix}:${runId}`;
  const rbTag = `${tag}:rollback`;
  const messages: string[] = [];
  const COLUMN_TYPES: Record<string, string> = {
    is_active: 'boolean',
    start_date: 'date',
    end_date: 'date',
  };

  return db.transaction(async (tx) => {
    await lockTables(tx);
    const [{ ok }] = await tx.query<{ ok: boolean } & Row>(
      `SELECT to_regclass('public.term_backfill_audit') IS NOT NULL AS ok`,
    );
    if (!ok) throw new Abort('term_backfill_audit does not exist — nothing to roll back.');

    const rows = await tx.query<
      { table_name: string; row_id: string; column_name: string; old_value: string | null; new_value: string | null } & Row
    >(
      `SELECT table_name, row_id, column_name, old_value, new_value
         FROM term_backfill_audit WHERE migration = $1 ORDER BY id`,
      tag,
    );
    if (rows.length === 0) throw new Abort(`No audit rows for run ${runId}.`);
    const [{ n: done }] = await tx.query<{ n: number } & Row>(
      `SELECT count(*)::int AS n FROM term_backfill_audit WHERE migration = $1`,
      rbTag,
    );
    if (done > 0) throw new Abort(`Run ${runId} was already rolled back.`);

    const triggers = await loadTriggers(tx);
    await setFreezeTriggers(tx, triggers, false);

    // 1. Carry-over rows this run inserted.
    const insertedPoints = rows.filter((r) => r.table_name === 'points_log' && r.column_name === '__inserted__');
    for (const r of insertedPoints) {
      const n = await tx.exec(
        `DELETE FROM points_log WHERE id = $1 AND source_type = $2`,
        r.row_id,
        CONFIG.carryover.sourceType,
      );
      await audit(tx, rbTag, 'points_log', r.row_id, '__deleted__', r.new_value, null);
      if (n !== 1) messages.push(`WARN carry-over row ${r.row_id} was already gone.`);
    }
    messages.push(`Carry-over rows removed: ${insertedPoints.length}`);

    // 2. Course of every moved row.
    for (const table of CONFIG.movableTables) {
      const expected = rows.filter((r) => r.table_name === table && r.column_name === 'term_id').length;
      if (expected === 0) continue;
      const restored = await tx.exec(
        `UPDATE "${table}" t
            SET term_id = a.old_value::int
           FROM term_backfill_audit a
          WHERE a.migration = $1 AND a.table_name = $2 AND a.column_name = 'term_id'
            AND a.row_id = t.id AND t.term_id = a.new_value::int`,
        tag,
        table,
      );
      await audit(tx, rbTag, table, '*', 'term_id', String(expected), String(restored));
      messages.push(`Restored ${table}: ${restored}/${expected}` + (restored < expected ? ' (missing rows were deleted by the app since)' : ''));
    }
    await setFreezeTriggers(tx, triggers, true);

    // 3. Courses. Deactivate everything this run touched first (one-active index).
    const termRows = rows.filter((r) => r.table_name === 'terms');
    const touched = [...new Set(termRows.map((r) => r.row_id))];
    for (const id of touched) {
      await tx.exec(`UPDATE terms SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1::int`, id);
    }
    for (const r of termRows) {
      if (r.column_name === '__inserted__') {
        const [{ refs }] = await tx.query<{ refs: number } & Row>(
          `SELECT ((SELECT count(*) FROM points_log         WHERE term_id = $1::int)
                 + (SELECT count(*) FROM recitations        WHERE term_id = $1::int)
                 + (SELECT count(*) FROM hadith_recitations WHERE term_id = $1::int))::int AS refs`,
          r.row_id,
        );
        if (refs === 0) {
          await tx.exec(`DELETE FROM terms WHERE id = $1::int`, r.row_id);
          await audit(tx, rbTag, 'terms', r.row_id, '__deleted__', r.new_value, null);
          messages.push(`Winter course ${r.row_id} removed (it was created by this run).`);
        } else {
          messages.push(
            `WARN winter course ${r.row_id} kept (inactive): ${refs} row(s) were recorded in it after the run.`,
          );
        }
        continue;
      }
      const type = COLUMN_TYPES[r.column_name];
      if (!type) throw new Error(`Unexpected audited terms column "${r.column_name}".`);
      if (r.column_name === 'is_active') continue; // restored below, after every deactivation
      await tx.exec(
        `UPDATE terms SET "${r.column_name}" = $2::${type}, updated_at = CURRENT_TIMESTAMP WHERE id = $1::int`,
        r.row_id,
        r.old_value,
      );
    }
    for (const r of termRows.filter((x) => x.column_name === 'is_active' && x.old_value === 'true')) {
      await tx.exec(`UPDATE terms SET is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1::int`, r.row_id);
    }
    await audit(tx, rbTag, 'terms', '*', '__restored__', null, touched.join(','));

    for (const t of await loadTriggers(tx)) {
      if (t.enabled !== 'O') throw new Error(`Post-condition failed: trigger ${t.name} is "${t.enabled}".`);
    }
    return { mode: 'rollback', runId, messages };
  }, CONFIG.txTimeoutMs);
}

// ═══════════════════════════════════════════════════════════════════════════
// Reporting
// ═══════════════════════════════════════════════════════════════════════════

export function printPlan(plan: Plan): void {
  const line = '─'.repeat(78);
  console.log(`\n${line}\nPostgreSQL ${plan.db.version} · TimeZone=${plan.db.timeZone}\n${line}`);

  console.log('\nCOURSES (now)');
  for (const t of plan.terms) {
    console.log(
      `  ${String(t.id).padStart(3)}  ${t.is_active ? '●' : '○'}  ${t.start_date} → ${t.end_date ?? '…'}  ${t.name}  ${t.name_ar}`,
    );
  }
  console.log('\nCOURSE CHANGES');
  if (plan.termOps.length === 0) console.log('  (none)');
  for (const op of plan.termOps) {
    if (op.kind === 'close-summer') console.log(`  • close summer (id ${op.termId}): active=false, end=${CONFIG.summerEndDate}`);
    if (op.kind === 'create-winter') console.log(`  • create "${CONFIG.winterTerm.nameAr}" active from ${CONFIG.cutoffDate}`);
    if (op.kind === 'update-winter') console.log(`  • winter (id ${op.termId}): active=true, start=${CONFIG.cutoffDate}, end=∅`);
  }

  console.log('\nROWS BY CURRENT → TARGET COURSE');
  for (const r of plan.moves.summary) {
    const arrow = r.cur === r.tgt ? 'stays ' : 'MOVES ';
    console.log(
      `  ${r.tbl.padEnd(19)} ${r.cur.padEnd(6)} → ${r.tgt.padEnd(6)} ${arrow} ${String(r.n).padStart(6)} rows` +
        (r.tbl === 'points_log' ? `  ${fmt(r.pts).padStart(10)} pts` : '') +
        `  [${r.first_day} … ${r.last_day}]`,
    );
  }
  console.log(`  rows to move: ${plan.moves.count}`);

  console.log('\nEXEMPT STUDENTS — balance carried into winter');
  plan.exempt.forEach((r, i) => {
    const c = plan.carryovers.find((x) => x.studentId === r.student?.id);
    const flag = r.matchKind === 'corrected' ? '  ⚠ spelling corrected — confirm' : '';
    const status = r.error
      ? `✗ ${r.error}`
      : `${c?.status === 'insert' ? '+' : c?.status === 'already-carried' ? '=' : '·'} ${fmt(c?.amount ?? 0)}` +
        `  (summer balance ${fmt(c?.summerAfter ?? 0)})`;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.entry.input}` +
        (r.entry.input !== r.entry.name ? ` → ${r.entry.name}` : '') +
        ` بن ${r.entry.father}   ${status}${flag}`,
    );
  });

  if (plan.warnings.length) {
    console.log('\nWARNINGS');
    for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
  }
  if (plan.errors.length) {
    console.log('\nERRORS (apply is blocked until these are fixed)');
    for (const e of plan.errors) console.log(`  ✗ ${e}`);
  }
  console.log(`\nawarded_by: ${plan.admin.username || '—'}   triggers: ${plan.triggers.map((t) => `${t.name}=${t.enabled}`).join(', ') || 'none found'}`);
  console.log(`FINGERPRINT: ${plan.fingerprint}${plan.isNoop ? '   (nothing to do — already applied)' : ''}\n`);
}

export function writeBalancesCsv(plan: Plan, file: string): void {
  const exemptIds = new Map(plan.carryovers.map((c) => [c.studentId, c]));
  writeCsv(
    file,
    [
      'الطالب', 'اسم الأب', 'مستثنى من التصفير',
      'الصيفية قبل', 'الشتوية قبل',
      'الصيفية بعد (أرشيف)', 'نقاط الشتوية منذ 19-9', 'رصيد مرحّل', 'رصيد الشتوية الكلي',
    ],
    plan.balances.map((b) => {
      const c = exemptIds.get(b.student_id);
      const carried = c && c.status !== 'skipped-non-positive' ? toNum(c.status === 'insert' ? c.amount : c.existingAmount) : 0;
      return [
        b.full_name, b.father_name, c ? 'نعم' : '',
        fmt(b.summer_before), fmt(b.winter_before),
        fmt(b.summer_after), fmt(b.winter_earned), fmt(carried), fmt(toNum(b.winter_earned) + carried),
      ];
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(argv: string[]) {
  const out: { apply: boolean; confirm?: string; rollback?: string; admin?: string } = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--confirm=')) out.confirm = a.slice(10);
    else if (a.startsWith('--rollback=')) out.rollback = a.slice(11);
    else if (a.startsWith('--admin=')) out.admin = a.slice(8);
    else throw new Abort(`Unknown argument "${a}".`);
  }
  if (out.apply && out.rollback) throw new Abort('--apply and --rollback are mutually exclusive.');
  if (out.apply && !out.confirm) throw new Abort('--apply needs --confirm=<fingerprint> from the dry run.');
  if (out.rollback && !/^\d{8}-\d{6}$/.test(out.rollback)) throw new Abort('--rollback expects a run id like 20261013-210501.');
  return out;
}

function databaseUrl(): string {
  const url = process.env.SPLIT_DATABASE_URL;
  if (!url) throw new Abort('SPLIT_DATABASE_URL is not set.');
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Abort('SPLIT_DATABASE_URL is not a postgres connection string.');
  if (/railway\.internal/.test(url)) throw new Abort('Internal Railway host — use DATABASE_PUBLIC_URL.');
  return url;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = databaseUrl();
  const masked = url.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@');
  console.log(`Target: ${masked}`);

  // Loaded lazily so the module can be imported (tests) without a generated client.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: Client } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new Client({ datasources: { db: { url } } });
  const db = prismaDb(prisma);
  const runId = runIdNow();

  try {
    if (args.rollback) {
      const res = await rollback(db, args.rollback);
      res.messages.forEach((m) => console.log(`  ${m}`));
      console.log(`\n✓ Run ${args.rollback} rolled back.\n`);
      return;
    }

    if (!args.apply) {
      const plan = await dryRun(db, { adminUsername: args.admin });
      printPlan(plan);
      const csv = path.resolve('exports', `winter-split-dryrun-${runId}.csv`);
      writeBalancesCsv(plan, csv);
      console.log(`Per-student report: ${csv}`);
      console.log('DRY RUN — nothing was written.');
      if (plan.errors.length === 0 && !plan.isNoop) {
        console.log('\nAfter reviewing, apply with:');
        console.log(
          `  npx ts-node --transpile-only scripts/winter-2026-split.ts --apply --confirm=${plan.fingerprint}` +
            (args.admin ? ` --admin=${args.admin}` : ''),
        );
      }
      return;
    }

    const res = await apply(db, { confirm: args.confirm!, adminUsername: args.admin, runId });
    res.messages.forEach((m) => console.log(`  ${m}`));
    if (res.noop) return;
    const csv = path.resolve('exports', `winter-split-applied-${runId}.csv`);
    writeBalancesCsv(res.plan!, csv);
    console.log(`\n✓ COMMITTED. Run id: ${runId}`);
    console.log(`  Backup:  ${path.resolve('_backups', `winter-split-${runId}.json`)}`);
    console.log(`  Report:  ${csv}`);
    console.log(`  Undo:    npx ts-node --transpile-only scripts/winter-2026-split.ts --rollback=${runId}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    if (err instanceof Abort) {
      console.error(`\n✗ ABORT: ${err.message}\n  No changes were made.`);
    } else {
      console.error('\n✗ FAILED — the transaction was rolled back; no changes were made.');
      console.error(err);
    }
    process.exit(1);
  });
}
