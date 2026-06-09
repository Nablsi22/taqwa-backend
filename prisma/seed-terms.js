// ═══════════════════════════════════════════════════════════════════════════
// prisma/seed-terms.js
//
// CommonJS port of seed-terms.ts so it runs in production container
// without ts-node. Matches the pattern of seed_admin.js and seed-rules.js.
//
// Idempotent: safe to re-run on every container start. Terms are upserted
// by `name`. Backfill UPDATEs only target rows where term_id IS NULL.
// ═══════════════════════════════════════════════════════════════════════════

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Everything BEFORE this date is winter; FROM this date onward is summer.
const SUMMER_CUTOFF = new Date('2026-06-06T00:00:00.000Z');

const WINTER_NAME    = 'winter-2025-2026';
// Arabic: الدورة الشتوية 2025-2026
// Built from explicit Unicode codepoints to bypass terminal RTL reversal.
const WINTER_NAME_AR = String.fromCharCode(
  0x0627, 0x0644, 0x062F, 0x0648, 0x0631, 0x0629, 0x0020,
  0x0627, 0x0644, 0x0634, 0x062A, 0x0648, 0x064A, 0x0629, 0x0020,
  0x0032, 0x0030, 0x0032, 0x0035, 0x002D, 0x0032, 0x0030, 0x0032, 0x0036
);
const SUMMER_NAME    = 'summer-2026';
// Arabic: الدورة الصيفية 2026
const SUMMER_NAME_AR = String.fromCharCode(
  0x0627, 0x0644, 0x062F, 0x0648, 0x0631, 0x0629, 0x0020,
  0x0627, 0x0644, 0x0635, 0x064A, 0x0641, 0x064A, 0x0629, 0x0020,
  0x0032, 0x0030, 0x0032, 0x0036
);

async function main() {
  console.log('Term seed/backfill starting...');

  // Determine winter's start from earliest recitation, fallback otherwise.
  const minRec = await prisma.recitation.aggregate({ _min: { date: true } });
  const winterStart = minRec._min.date || new Date('2025-09-01');

  // Winter (inactive, historical)
  let winter;
  try {
    winter = await prisma.term.upsert({
      where:  { name: WINTER_NAME },
      create: {
        name:      WINTER_NAME,
        nameAr:    WINTER_NAME_AR,
        startDate: winterStart,
        endDate:   new Date('2026-06-05'),
        isActive:  false,
      },
      update: {},
    });
    console.log('Winter term id=' + winter.id + ' (' + winter.nameAr + ')');
  } catch (e) {
    console.log('Winter term upsert error: ' + e.message);
    throw e;
  }

  // Deactivate any other active term first (partial unique index enforces one-active)
  try {
    await prisma.term.updateMany({
      where: { isActive: true, name: { not: SUMMER_NAME } },
      data:  { isActive: false },
    });
  } catch (e) {
    console.log('Deactivate-others error: ' + e.message);
  }

  // Summer (active, new chapter)
  let summer;
  try {
    summer = await prisma.term.upsert({
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
    console.log('Summer term id=' + summer.id + ' (' + summer.nameAr + ') ACTIVE');
  } catch (e) {
    console.log('Summer term upsert error: ' + e.message);
    throw e;
  }

  // Backfill recitations
  try {
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
    console.log('Recitations: ' + recWinter + ' -> winter, ' + recSummer + ' -> summer');
  } catch (e) {
    console.log('Recitations backfill error: ' + e.message);
  }

  // Backfill points_log
  try {
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
    console.log('Points: ' + pntWinter + ' -> winter, ' + pntSummer + ' -> summer');
  } catch (e) {
    console.log('Points backfill error: ' + e.message);
  }

  // Orphan sanity check
  try {
    const orphanRec = await prisma.recitation.count({ where: { termId: null } });
    const orphanPnt = await prisma.pointsLog.count({ where: { termId: null } });
    if (orphanRec > 0 || orphanPnt > 0) {
      console.log('Orphan rows: recitations=' + orphanRec + ', points=' + orphanPnt);
    } else {
      console.log('No orphan rows. Backfill complete.');
    }
  } catch (e) {
    console.log('Orphan check error: ' + e.message);
  }

  console.log('Term seed/backfill done.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
