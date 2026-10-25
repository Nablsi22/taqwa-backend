/* eslint-disable no-console */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * scripts/db-snapshot.ts
 *
 * READ-ONLY. Proves that a deploy lost or changed no existing data.
 *
 *   1. Before the deploy:   take a snapshot.
 *   2. After the deploy:    take a second snapshot with --compare=<first>.
 *      Every row that existed at the first snapshot is checked, row by row:
 *      it must still exist and its protected columns must be byte-identical.
 *      Rows added after the first snapshot (ids it did not have) are reported
 *      but are not errors. Rows are matched by id, never by timestamp, so the
 *      result does not depend on any time zone.
 *
 * The snapshot also records the full database structure (columns, types,
 * defaults, constraints, indexes, triggers, trigger functions, enums,
 * sequences, applied migrations). That lets a deploy be rehearsed on an
 * exact empty copy of the production schema before it touches production.
 *
 * Privacy: the snapshot holds NO personal data. Rows are reduced to an id and
 * a truncated MD5 of their protected columns; names, phones and the like
 * never leave the database. Aggregates are counts and point totals only.
 *
 * Every query runs in one `REPEATABLE READ, READ ONLY` transaction, so the
 * snapshot is internally consistent and PostgreSQL itself rejects any write.
 *
 * Usage (PowerShell, from the backend folder):
 *   $env:SNAPSHOT_DATABASE_URL = '<Railway → Postgres → DATABASE_PUBLIC_URL>'
 *   npx ts-node --transpile-only scripts/db-snapshot.ts
 *   npx ts-node --transpile-only scripts/db-snapshot.ts --compare=exports/db-snapshot-<runId>.json
 *   Remove-Item Env:SNAPSHOT_DATABASE_URL
 *
 * Exit code: 0 = identical (or no comparison), 2 = differences found.
 *
 * References
 *   Read-only transactions     https://www.postgresql.org/docs/current/sql-set-transaction.html
 *   System catalog functions   https://www.postgresql.org/docs/current/functions-info.html#FUNCTIONS-INFO-CATALOG
 *   md5()                      https://www.postgresql.org/docs/current/functions-string.html
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration — which columns of which tables are protected
// ═══════════════════════════════════════════════════════════════════════════

/**
 * For each table: the key column and the columns whose values must survive a
 * deploy unchanged. Columns that legitimately change in normal use
 * (last_login, fcm_token, updated_at, …) are deliberately left out. A column
 * listed here that does not exist in the database is skipped and reported,
 * so the script never fails on schema drift.
 */
export const PROTECTED: Record<string, { key: string; columns: string[] }> = {
  users: { key: 'id', columns: ['id', 'username', 'role', 'created_at'] },
  students: { key: 'id', columns: ['id', 'user_id', 'full_name', 'father_name', 'date_of_birth', 'created_at'] },
  instructors: { key: 'id', columns: ['id', 'user_id', 'full_name', 'created_at'] },
  attendance: { key: 'id', columns: ['id', 'student_id', 'date', 'status', 'created_at'] },
  points_log: {
    key: 'id',
    columns: ['id', 'student_id', 'category_id', 'amount', 'rating', 'term_id', 'source_type', 'source_id', 'awarded_by', 'created_at'],
  },
  recitations: {
    key: 'id',
    columns: [
      'id', 'student_id', 'instructor_id', 'surah_number', 'surah_numbers', 'rating', 'date', 'term_id', 'created_at',
      'startSurah', 'startAya', 'endSurah', 'endAya', 'pages_recited', 'pagesCalculated', 'is_complete_sura',
    ],
  },
  hadith_recitations: { key: 'id', columns: ['id', 'student_id', 'instructor_id', 'hadith_number', 'points_awarded', 'term_id', 'created_at'] },
  terms: { key: 'id', columns: ['id', 'name', 'name_ar', 'start_date', 'end_date', 'is_active', 'created_at'] },
  point_categories: { key: 'id', columns: ['id', 'name', 'type', 'default_value', 'created_at'] },
  point_rules: { key: 'id', columns: ['id', 'code', 'points', 'is_per_page', 'created_at'] },
  hadith_points_rules: { key: 'hadith_number', columns: ['hadith_number', 'base_points'] },
  gifts: { key: 'id', columns: ['id', 'name', 'points_cost', 'created_at'] },
  announcements: { key: 'id', columns: ['id', 'title', 'published_at', 'created_by'] },
  instructor_attendance: { key: 'id', columns: ['id', 'instructor_id', 'date', 'present'] },
  quran_progress: { key: 'id', columns: ['id', 'student_id', 'created_at'] },
  notifications: { key: 'id', columns: ['id', 'created_at'] },
  media: { key: 'id', columns: ['id', 'created_at'] },
  temp_assignments: { key: 'id', columns: ['id', 'student_id', 'created_at'] },
  term_backfill_audit: { key: 'id', columns: ['id', 'migration', 'table_name', 'row_id', 'column_name', 'old_value', 'new_value'] },
};

/** Characters of each row's MD5 kept in the snapshot — 64 bits, plenty to detect any change. */
const HASH_CHARS = 16;
const TX_TIMEOUT_MS = 120_000;

// ═══════════════════════════════════════════════════════════════════════════
// Database port (same contract as the other scripts in this folder)
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
            query: <R extends Row = Row>(sql: string, ...p: Param[]) => t.$queryRawUnsafe<R[]>(sql, ...p),
            exec: (sql: string, ...p: Param[]) => t.$executeRawUnsafe(sql, ...p),
          }),
        { maxWait: 15_000, timeout: timeoutMs },
      ) as Promise<T>,
  };
}

export class Abort extends Error {}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot shape
// ═══════════════════════════════════════════════════════════════════════════

export interface TableSnapshot {
  key: string;
  columns: string[];
  missingColumns: string[];
  rowCount: number;
  /** id → truncated MD5 of the protected columns. */
  rows: Record<string, string>;
}

export interface SchemaSnapshot {
  enums: { name: string; labels: string[] }[];
  sequences: { name: string; ownedBy: string | null }[];
  tables: {
    name: string;
    columns: { name: string; type: string; notNull: boolean; default: string | null }[];
  }[];
  constraints: { table: string; name: string; type: string; definition: string; validated: boolean }[];
  indexes: { table: string; name: string; definition: string }[];
  functions: { name: string; definition: string }[];
  triggers: { table: string; name: string; enabled: string; definition: string }[];
  migrations: { name: string; finished: boolean }[];
}

export interface Snapshot {
  version: 1;
  takenAt: string; // database clock, UTC ISO
  server: string;
  tables: Record<string, TableSnapshot>;
  absentTables: string[];
  pointsByTerm: { termId: number | null; rows: number; total: string }[];
  schema: SchemaSnapshot;
  /** SHA-256 of the canonical JSON of everything above — a one-line fingerprint. */
  fingerprint: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Quote an identifier for PostgreSQL. Names come from CONFIG and the catalog, never from input. */
export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

export function fingerprintOf(s: Omit<Snapshot, 'fingerprint'>): string {
  return createHash('sha256').update(canonical(s)).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════
// Collect
// ═══════════════════════════════════════════════════════════════════════════

async function readSchema(tx: Tx): Promise<SchemaSnapshot> {
  const enums = await tx.query<{ name: string; labels: string[] }>(
    `SELECT t.typname::text AS name,
            array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
     FROM pg_type t
     JOIN pg_enum e ON e.enumtypid = t.oid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     GROUP BY t.typname ORDER BY t.typname`,
  );
  const sequences = await tx.query<{ name: string; owned_by: string | null }>(
    `SELECT c.relname::text AS name,
            (SELECT d.refobjid::regclass::text || '.' || a.attname
               FROM pg_depend d
               JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.objid = c.oid AND d.deptype = 'a' LIMIT 1) AS owned_by
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
     ORDER BY c.relname`,
  );
  const cols = await tx.query<{ tbl: string; name: string; type: string; not_null: boolean; dflt: string | null }>(
    `SELECT c.relname::text AS tbl, a.attname::text AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS dflt
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname, a.attnum`,
  );
  const tables: SchemaSnapshot['tables'] = [];
  for (const c of cols) {
    let t = tables.find((x) => x.name === c.tbl);
    if (!t) tables.push((t = { name: c.tbl, columns: [] }));
    t.columns.push({ name: c.name, type: c.type, notNull: c.not_null, default: c.dflt });
  }
  // contype 'n' (PostgreSQL 18 NOT NULL constraints) is already covered by notNull.
  const constraints = await tx.query<{ tbl: string; name: string; type: string; definition: string; validated: boolean }>(
    `SELECT c.relname::text AS tbl, k.conname::text AS name, k.contype::text AS type,
            pg_get_constraintdef(k.oid) AS definition, k.convalidated AS validated
     FROM pg_constraint k
     JOIN pg_class c ON c.oid = k.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND k.contype IN ('p', 'u', 'f', 'c', 'x')
     ORDER BY c.relname, k.contype, k.conname`,
  );
  const indexes = await tx.query<{ tbl: string; name: string; definition: string }>(
    `SELECT t.relname::text AS tbl, i.relname::text AS name, pg_get_indexdef(x.indexrelid) AS definition
     FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_class t ON t.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid)
     ORDER BY t.relname, i.relname`,
  );
  const triggers = await tx.query<{ tbl: string; name: string; enabled: string; definition: string; fn: string }>(
    `SELECT c.relname::text AS tbl, t.tgname::text AS name, t.tgenabled::text AS enabled,
            pg_get_triggerdef(t.oid) AS definition, t.tgfoid::regproc::text AS fn
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY c.relname, t.tgname`,
  );
  const functions = await tx.query<{ name: string; definition: string }>(
    `SELECT DISTINCT p.proname::text AS name, pg_get_functiondef(p.oid) AS definition
     FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1`,
  );
  const hasMigrations = (
    await tx.query<{ ok: boolean }>(`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS ok`)
  )[0].ok;
  const migrations = hasMigrations
    ? await tx.query<{ name: string; finished: boolean }>(
        `SELECT migration_name AS name, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished
         FROM _prisma_migrations ORDER BY started_at, migration_name`,
      )
    : [];

  return {
    enums,
    sequences: sequences.map((s) => ({ name: s.name, ownedBy: s.owned_by })),
    tables,
    constraints: constraints.map((c) => ({ table: c.tbl, name: c.name, type: c.type, definition: c.definition, validated: c.validated })),
    indexes: indexes.map((i) => ({ table: i.tbl, name: i.name, definition: i.definition })),
    functions,
    triggers: triggers.map((t) => ({ table: t.tbl, name: t.name, enabled: t.enabled, definition: t.definition })),
    migrations,
  };
}

/** Per-row hashes of one table. */
async function readTable(
  tx: Tx,
  table: string,
  spec: { key: string; columns: string[] },
  existing: string[],
  /** When comparing: hash exactly the columns the earlier snapshot hashed. */
  columnsOverride?: string[],
): Promise<TableSnapshot> {
  const wanted = columnsOverride ?? spec.columns;
  const present = wanted.filter((c) => existing.includes(c));
  const missingColumns = wanted.filter((c) => !existing.includes(c));
  if (!existing.includes(spec.key)) throw new Abort(`Table ${table} has no key column "${spec.key}".`);
  // ROW(...)::text is PostgreSQL's canonical text of the values. Timestamps
  // here are `timestamp without time zone`, so their text does not depend on
  // the session's TimeZone either.
  const rowExpr = `ROW(${present.map(qi).join(', ')})::text`;
  const rows = await tx.query<{ k: string; h: string }>(
    `SELECT ${qi(spec.key)}::text AS k, left(md5(${rowExpr}), ${HASH_CHARS}) AS h
     FROM ${qi(table)} ORDER BY 1`,
  );
  return {
    key: spec.key,
    columns: present,
    missingColumns,
    rowCount: rows.length,
    rows: Object.fromEntries(rows.map((r) => [r.k, r.h])),
  };
}

export async function takeSnapshot(db: Db, opts: { columnsFrom?: Snapshot } = {}): Promise<Snapshot> {
  return db.transaction(async (tx) => {
    await tx.exec(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const [meta] = await tx.query<{ now: string; server: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now,
              current_setting('server_version') AS server`,
    );
    const schema = await readSchema(tx);

    const tables: Record<string, TableSnapshot> = {};
    const absentTables: string[] = [];
    for (const [table, spec] of Object.entries(PROTECTED)) {
      const t = schema.tables.find((x) => x.name === table);
      if (!t) {
        absentTables.push(table);
        continue;
      }
      tables[table] = await readTable(
        tx,
        table,
        spec,
        t.columns.map((c) => c.name),
        opts.columnsFrom?.tables[table]?.columns,
      );
    }

    const hasPoints = schema.tables.some((t) => t.name === 'points_log');
    const pointsByTerm = hasPoints
      ? (
          await tx.query<{ term_id: number | null; rows: number; total: string }>(
            `SELECT term_id::int AS term_id, count(*)::int AS rows, COALESCE(sum(amount), 0)::text AS total
             FROM points_log GROUP BY term_id ORDER BY term_id NULLS FIRST`,
          )
        ).map((p) => ({ termId: p.term_id, rows: p.rows, total: p.total }))
      : [];

    const body: Omit<Snapshot, 'fingerprint'> = {
      version: 1,
      takenAt: meta.now,
      server: meta.server,
      tables,
      absentTables,
      pointsByTerm,
      schema,
    };
    return { ...body, fingerprint: fingerprintOf(body) };
  }, TX_TIMEOUT_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
// Compare
// ═══════════════════════════════════════════════════════════════════════════

export interface TableDiff {
  table: string;
  before: number;
  after: number;
  missing: string[];
  changed: string[];
  newerRows: number;
  columnsNoLongerPresent: string[];
}

export interface Comparison {
  identical: boolean;
  tables: TableDiff[];
  tablesDropped: string[];
  pointsByTerm: { termId: number | null; before: string; after: string; beforeRows: number; afterRows: number }[];
  pointsIdentical: boolean;
  schemaChanges: string[];
}

/**
 * Every row of `before` must exist in `after` with the same hash. Ids present
 * only in `after` are new rows. Points: `amount` and `term_id` are protected
 * columns of points_log, so "no points_log row missing or changed" means every
 * earlier point is intact; course totals are shown alongside for reference
 * (the "after" totals include points earned since).
 */
export function compare(before: Snapshot, after: Snapshot): Comparison {
  const tables: TableDiff[] = [];
  const tablesDropped: string[] = [];
  for (const [name, b] of Object.entries(before.tables)) {
    const a = after.tables[name];
    if (!a) {
      tablesDropped.push(name);
      continue;
    }
    const missing: string[] = [];
    const changed: string[] = [];
    // `after` hashed exactly the columns `before` hashed (columnsFrom), so a
    // column added by a migration can never register as a change, and a
    // protected column that disappeared is reported below.
    for (const [id, h] of Object.entries(b.rows)) {
      if (!(id in a.rows)) missing.push(id);
      else if (a.rows[id] !== h) changed.push(id);
    }
    tables.push({
      table: name,
      before: b.rowCount,
      after: Object.keys(a.rows).filter((id) => id in b.rows).length,
      missing,
      changed,
      newerRows: Object.keys(a.rows).filter((id) => !(id in b.rows)).length,
      columnsNoLongerPresent: a.missingColumns.filter((c) => b.columns.includes(c)),
    });
  }

  const pts = new Map<string, Comparison['pointsByTerm'][number]>();
  const keyOf = (t: number | null) => String(t);
  for (const p of before.pointsByTerm) {
    pts.set(keyOf(p.termId), { termId: p.termId, before: p.total, after: '0', beforeRows: p.rows, afterRows: 0 });
  }
  for (const p of after.pointsByTerm) {
    const e = pts.get(keyOf(p.termId)) ?? { termId: p.termId, before: '0', after: '0', beforeRows: 0, afterRows: 0 };
    e.after = p.total;
    e.afterRows = p.rows;
    pts.set(keyOf(p.termId), e);
  }
  const pointsByTerm = [...pts.values()];
  const pl = tables.find((t) => t.table === 'points_log');
  const pointsIdentical = !tablesDropped.includes('points_log') && (!pl || (pl.missing.length === 0 && pl.changed.length === 0));

  const schemaChanges: string[] = [];
  const colKey = (t: string, c: { name: string; type: string; notNull: boolean; default: string | null }) =>
    `${t}.${c.name} ${c.type}${c.notNull ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${c.default}` : ''}`;
  const bc = new Set(before.schema.tables.flatMap((t) => t.columns.map((c) => colKey(t.name, c))));
  const ac = new Set(after.schema.tables.flatMap((t) => t.columns.map((c) => colKey(t.name, c))));
  for (const c of ac) if (!bc.has(c)) schemaChanges.push(`+ column ${c}`);
  for (const c of bc) if (!ac.has(c)) schemaChanges.push(`- column ${c}`);
  const set = (xs: { name: string; definition: string }[]) => new Set(xs.map((x) => `${x.name}: ${x.definition}`));
  for (const [label, b, a] of [
    ['constraint', set(before.schema.constraints), set(after.schema.constraints)],
    ['index', set(before.schema.indexes), set(after.schema.indexes)],
    ['trigger', set(before.schema.triggers), set(after.schema.triggers)],
  ] as const) {
    for (const x of a) if (!b.has(x)) schemaChanges.push(`+ ${label} ${x}`);
    for (const x of b) if (!a.has(x)) schemaChanges.push(`- ${label} ${x}`);
  }
  const bm = new Set(before.schema.migrations.filter((m) => m.finished).map((m) => m.name));
  for (const m of after.schema.migrations) if (m.finished && !bm.has(m.name)) schemaChanges.push(`+ migration ${m.name}`);

  const identical =
    tablesDropped.length === 0 &&
    tables.every((t) => t.missing.length === 0 && t.changed.length === 0 && t.columnsNoLongerPresent.length === 0) &&
    pointsIdentical;
  return { identical, tables, tablesDropped, pointsByTerm, pointsIdentical, schemaChanges };
}

// ═══════════════════════════════════════════════════════════════════════════
// Reporting / CLI
// ═══════════════════════════════════════════════════════════════════════════

export function printSnapshot(s: Snapshot): void {
  console.log(`\nPostgreSQL ${s.server} · taken at ${s.takenAt} (UTC) · READ ONLY`);
  console.log(`fingerprint ${s.fingerprint}`);
  console.log('\nprotected rows');
  for (const [name, t] of Object.entries(s.tables)) {
    const miss = t.missingColumns.length ? `  [columns not in DB: ${t.missingColumns.join(', ')}]` : '';
    console.log(`  ${name.padEnd(24)} ${String(t.rowCount).padStart(7)}${miss}`);
  }
  if (s.absentTables.length) console.log(`  absent tables: ${s.absentTables.join(', ')}`);
  console.log('\npoints by course');
  for (const p of s.pointsByTerm) {
    console.log(`  term ${String(p.termId ?? 'NULL').padEnd(5)} ${String(p.rows).padStart(7)} rows  ${p.total} pts`);
  }
  console.log(
    `\nschema: ${s.schema.tables.length} tables, ${s.schema.constraints.length} constraints, ` +
      `${s.schema.indexes.length} indexes, ${s.schema.triggers.length} triggers, ` +
      `${s.schema.migrations.filter((m) => m.finished).length} migrations applied`,
  );
}

export function printComparison(c: Comparison): void {
  console.log('\n══════════ COMPARISON with the earlier snapshot ══════════');
  for (const t of c.tables) {
    const bad = t.missing.length || t.changed.length || t.columnsNoLongerPresent.length;
    console.log(
      `  ${bad ? '✗' : '✓'} ${t.table.padEnd(24)} ${String(t.before).padStart(7)} → ${String(t.after).padStart(7)}` +
        (t.missing.length ? `  MISSING ${t.missing.length}` : '') +
        (t.changed.length ? `  CHANGED ${t.changed.length}` : '') +
        (t.columnsNoLongerPresent.length ? `  COLUMNS GONE ${t.columnsNoLongerPresent.join(', ')}` : '') +
        (t.newerRows ? `  (+${t.newerRows} new rows since)` : ''),
    );
    for (const id of t.missing.slice(0, 10)) console.log(`      missing ${id}`);
    for (const id of t.changed.slice(0, 10)) console.log(`      changed ${id}`);
  }
  for (const t of c.tablesDropped) console.log(`  ✗ ${t} — TABLE GONE`);
  console.log(`\n  earlier points: ${c.pointsIdentical ? '✓ every row intact (amount and course)' : '✗ CHANGED'}`);
  console.log('  course totals (after includes points earned since the first snapshot):');
  for (const p of c.pointsByTerm) {
    console.log(`    term ${String(p.termId ?? 'NULL').padEnd(5)} ${p.before} → ${p.after}  (${p.beforeRows} → ${p.afterRows} rows)`);
  }
  console.log(`\n  schema changes (${c.schemaChanges.length}):`);
  c.schemaChanges.forEach((x) => console.log(`    ${x.length > 160 ? x.slice(0, 157) + '…' : x}`));
  console.log(
    c.identical
      ? '\n✓ IDENTICAL — every earlier row is present and unchanged.\n'
      : '\n✗ DIFFERENCES FOUND — see above.\n',
  );
}

export function runIdNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv: string[]): { compare?: string } {
  const out: { compare?: string } = {};
  for (const a of argv) {
    if (a.startsWith('--compare=')) out.compare = a.slice('--compare='.length);
    else throw new Abort(`Unknown argument "${a}".`);
  }
  return out;
}

function databaseUrl(): string {
  const url = process.env.SNAPSHOT_DATABASE_URL;
  if (!url) throw new Abort('SNAPSHOT_DATABASE_URL is not set.');
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Abort('SNAPSHOT_DATABASE_URL is not a postgres connection string.');
  if (/railway\.internal/.test(url)) throw new Abort('Internal Railway host — use DATABASE_PUBLIC_URL.');
  return url;
}

export function loadSnapshot(file: string): Snapshot {
  const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
  if (s.version !== 1) throw new Abort(`${file} is not a db-snapshot v1 file.`);
  const { fingerprint, ...body } = s;
  if (fingerprintOf(body) !== fingerprint) throw new Abort(`${file} has been modified (fingerprint mismatch).`);
  return s;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const before = args.compare ? loadSnapshot(path.resolve(args.compare)) : null;
  const url = databaseUrl();
  console.log(`Target: ${url.replace(/\/\/([^:]+):[^@]*@/, '//$1:****@')}`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: Client } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new Client({ datasources: { db: { url } } });
  try {
    const db = prismaDb(prisma);
    const snapshot = await takeSnapshot(db, { columnsFrom: before ?? undefined });
    printSnapshot(snapshot);
    const file = path.resolve('exports', `db-snapshot-${runIdNow()}${before ? '-compare' : ''}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot), 'utf8');
    console.log(`\nSnapshot: ${file}`);
    if (!before) return 0;
    const c = compare(before, snapshot);
    printComparison(c);
    return c.identical ? 0 : 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof Abort) console.error(`\n✗ ABORT: ${err.message}\n  Nothing was written to the database.`);
      else {
        console.error('\n✗ FAILED — read-only transaction rolled back; nothing was written.');
        console.error(err);
      }
      process.exit(1);
    });
}
