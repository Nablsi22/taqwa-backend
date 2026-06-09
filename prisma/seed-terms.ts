// ═══════════════════════════════════════════════════════════════════════════
// prisma/seed-terms.ts
//
// One-shot, idempotent seed + backfill for the Term feature.
// Run AFTER `prisma migrate deploy` has applied the schema migration.
//
// Usage (locally):    npx ts-node prisma/seed-terms.ts
// Usage (Railway):    railway run npx ts-node prisma/seed-terms.ts
//
// Idempotency guarantees:
//   • Terms are upserted by `name`, never duplicated.
//   • Backfill UPDATEs target only `term_id IS NULL` rows, leaving already-
//     tagged rows untouched. Safe to re-run.
// ═══════════════════════════════════════════════════════════════════════════

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Everything BEFORE this date is winter; FROM this date onward is summer.
const SUMMER_CUTOFF = new Date('2026-06-06T00:00:00.000Z');

const WINTER_NAME    = 'winter-2025-2026';
const WINTER_NAME_AR = 'الدورة الشتوية 2025-2026';
const SUMMER_NAME    = 'summer-2026';
const SUMMER_NAME_AR = 'الدورة الصيفية 2026';

async function main() {
  console.log('▶ Term seed/backfill starting…');

  // Determine winter's start from the earliest recitation; fallback otherwise.
  const minRec = await prisma.recitation.aggregate({ _min: { date: true } });
  const winterStart = minRec._min.date ?? new Date('2025-09-01');

  // ── Winter (inactive, historical) ──────────────────────────────────────
  const winter = await prisma.term.upsert({
    where:  { name: WINTER_NAME },
    create: {
      name:      WINTER_NAME,
      nameAr:    WINTER_NAME_AR,
      startDate: winterStart,
      endDate:   new Date('2026-06-05'),
      isActive:  false,
    },
    update: {}, // never mutate an existing term during seed
  });
  console.log(`  ✓ Winter term id=${winter.id} (${winter.nameAr})`);

  // ── Summer (active, new chapter) ──────────────────────────────────────
  // Note: the partial unique index "terms_only_one_active_idx" allows at
  // most one active term, so we deactivate any other active term first.
  await prisma.term.updateMany({
    where: { isActive: true, name: { not: SUMMER_NAME } },
    data:  { isActive: false },
  });

  const summer = await prisma.term.upsert({
    where:  { name: SUMMER_NAME },
    create: {
      name:      SUMMER_NAME,
      nameAr:    SUMMER_NAME_AR,
      startDate: SUMMER_CUTOFF,
      endDate:   null,
      isActive:  true,
    },
    update: { isActive: true },
  });
  console.log(`  ✓ Summer term id=${summer.id} (${summer.nameAr}) ACTIVE`);

  // ── Backfill recitations ──────────────────────────────────────────────
  const recWinter = await prisma.$executeRaw`
    UPDATE recitations
       SET term_id = ${winter.id}
     WHERE term_id IS NULL
       AND date < ${SUMMER_CUTOFF}
  `;
  const recSummer = await prisma.$executeRaw`
    UPDATE recitations
       SET term_id = ${summer.id}
     WHERE term_id IS NULL
       AND date >= ${SUMMER_CUTOFF}
  `;
  console.log(`  ✓ Recitations: ${recWinter} → winter, ${recSummer} → summer`);

  // ── Backfill points_log ───────────────────────────────────────────────
  // points_log uses `created_at` (timestamp). The recitation service's
  // `composePointsCreatedAt` ensures created_at matches the recitation date,
  // so this stays consistent with the recitations backfill above.
  const pntWinter = await prisma.$executeRaw`
    UPDATE points_log
       SET term_id = ${winter.id}
     WHERE term_id IS NULL
       AND created_at < ${SUMMER_CUTOFF}
  `;
  const pntSummer = await prisma.$executeRaw`
    UPDATE points_log
       SET term_id = ${summer.id}
     WHERE term_id IS NULL
       AND created_at >= ${SUMMER_CUTOFF}
  `;
  console.log(`  ✓ Points:      ${pntWinter} → winter, ${pntSummer} → summer`);

  // ── Sanity check ──────────────────────────────────────────────────────
  const orphanRec = await prisma.recitation.count({ where: { termId: null } });
  const orphanPnt = await prisma.pointsLog.count({ where: { termId: null } });
  if (orphanRec > 0 || orphanPnt > 0) {
    console.warn(
      `  ⚠ Orphan rows remaining: recitations=${orphanRec}, points=${orphanPnt}`,
    );
  } else {
    console.log('  ✓ No orphan rows — backfill complete.');
  }

  console.log('▶ Term seed/backfill done.');
}

main()
  .catch((err) => {
    console.error('✗ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });