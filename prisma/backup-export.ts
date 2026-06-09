// ═══════════════════════════════════════════════════════════════════════════
// prisma/backup-export.ts
//
// READ-ONLY production snapshot to JSON. Uses raw SQL exclusively
// ($queryRawUnsafe) so it works regardless of migration state — it does NOT
// rely on the generated Prisma Client matching the live schema. Safe to run
// before the terms migration is applied (no term_id dependency).
//
// Usage:
//   $env:DATABASE_URL = "<railway-public-url>"
//   npx ts-node prisma/backup-export.ts
//
// Output:
//   D:\taqwa-backups\taqwa-snapshot-<ISO-timestamp>.json
//
// Behavior:
//   1. Discovers public tables dynamically from pg_tables (excludes
//      _prisma_migrations). Nothing is hardcoded.
//   2. Dumps every row of every table via SELECT *.
//   3. Writes a single JSON file containing a `meta` block + one array per
//      table (keyed by the live Postgres table name).
//
// Safety:
//   • Read-only: no writes, no DDL, no model accessors.
//   • Builds the entire snapshot in memory; the file is written only after
//     ALL tables succeed. Any per-table failure aborts with NO partial file.
//   • Logs the target DB host with the password redacted.
//
// Consumed by: prisma/backup-restore.ts
//   NOTE: backup-restore.ts currently keys on camelCase model names and uses
//   the Prisma Client. The keys this script emits are live table names. The
//   two must be reconciled before a restore is attempted (follow-up task).
// ═══════════════════════════════════════════════════════════════════════════

import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const BACKUP_DIR = 'D:\\taqwa-backups';

// JSON.stringify replacer. Uses `this[key]` to inspect the ORIGINAL value
// before any toJSON() coercion, so we can serialize precisely:
//   • BigInt          → string (JSON has no bigint)
//   • Prisma Decimal  → string (preserve full precision; never go through float)
//   • Date            → falls through to native ISO-8601 (value is already
//                       the toJSON()-produced string here)
function jsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  if (typeof raw === 'bigint') return raw.toString();
  if (raw != null && Prisma.Decimal.isDecimal(raw as Prisma.Decimal)) {
    return (raw as Prisma.Decimal).toString();
  }
  return value;
}

function redactUrl(url: string | undefined): string {
  if (!url) return '<unset>';
  try {
    const u = new URL(url);
    return `${u.protocol}//***:***@${u.host}${u.pathname}`;
  } catch {
    return '<malformed>';
  }
}

// Safely double-quote a Postgres identifier coming from the catalog.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function discoverTables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
      ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

// Best-effort schema version: the latest finished Prisma migration name.
// Wrapped so a missing/empty _prisma_migrations table never aborts the export.
async function getSchemaVersion(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name
         FROM _prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1`,
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('✗ DATABASE_URL is not set. Aborting.');
    process.exit(1);
  }

  console.log('▶ Target DB host:', redactUrl(process.env.DATABASE_URL));

  const tables = await discoverTables();
  if (tables.length === 0) {
    console.error('✗ No tables found in schema "public". Aborting.');
    process.exit(1);
  }
  console.log(`▶ Discovered ${tables.length} tables:`, tables.join(', '));

  const schemaVersion = await getSchemaVersion();
  console.log('▶ Schema version (latest migration):', schemaVersion ?? '<unknown>');

  // Build the full snapshot in memory. If any table SELECT throws, the
  // exception propagates out of main() and we never reach the file write.
  const data: Record<string, unknown[]> = {};
  const rowCounts: Record<string, number> = {};

  console.log('\n▶ Exporting tables...');
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM ${quoteIdent(table)}`,
    );
    data[table] = rows;
    rowCounts[table] = rows.length;
    console.log(`  ✓ ${table.padEnd(24)} ${rows.length} rows`);
  }

  const capturedAt = new Date().toISOString();
  const snapshot = {
    meta: {
      capturedAt,
      schemaVersion,
      databaseHost: redactUrl(process.env.DATABASE_URL),
      tables,
      rowCounts,
    },
    ...data,
  };

  // All tables succeeded — now (and only now) write the file.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const fileName = `taqwa-snapshot-${capturedAt.replace(/:/g, '-')}.json`;
  const outPath = path.join(BACKUP_DIR, fileName);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, jsonReplacer, 2), 'utf8');

  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  console.log(`\n▶ Snapshot written: ${outPath}`);
  console.log(`  ${tables.length} tables, ${totalRows} total rows.`);
}

main()
  .catch((err) => {
    console.error('\n✗ Export failed — NO file written:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
