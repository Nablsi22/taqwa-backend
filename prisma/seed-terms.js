// ═══════════════════════════════════════════════════════════════════════════
// prisma/seed-terms.js
//
// Runs on EVERY container start (Dockerfile CMD), right after
// `prisma migrate deploy`.
//
// Contract: it NEVER changes an existing course.
//   • Courses exist  → read-only: it only logs which course is active.
//   • No course yet  → (a brand-new, empty database only) it creates the two
//                      historical courses, with summer-2026 active, exactly as
//                      the original seed did, so a fresh environment can record.
//
// Why: the previous version deactivated every active course not named
// "summer-2026" and set summer-2026 active again on every boot. Since the
// winter course (winter-2026-2027) became active on 2026-10-13, any restart
// would have silently moved all new points back into the summer course.
//
// The term_id backfill that used to live here is gone: every new row is
// stamped by the set_term_id_to_active trigger, and the 2026-09-05 migration
// both backfilled history and made term_id mandatory for new rows. Orphans are
// still counted and logged (read-only).
//
// It never fails the boot: any error is logged and the process exits 0, so a
// problem here can never keep the API from starting (the CMD chain is &&).
// ═══════════════════════════════════════════════════════════════════════════

const WINTER = {
  name: 'winter-2025-2026',
  // الدورة الشتوية 2025-2026 — built from code points to survive any terminal encoding
  nameAr: String.fromCharCode(
    0x0627, 0x0644, 0x062f, 0x0648, 0x0631, 0x0629, 0x0020,
    0x0627, 0x0644, 0x0634, 0x062a, 0x0648, 0x064a, 0x0629, 0x0020,
    0x0032, 0x0030, 0x0032, 0x0035, 0x002d, 0x0032, 0x0030, 0x0032, 0x0036,
  ),
  endDate: new Date('2026-06-05T00:00:00.000Z'),
};
const SUMMER = {
  name: 'summer-2026',
  // الدورة الصيفية 2026
  nameAr: String.fromCharCode(
    0x0627, 0x0644, 0x062f, 0x0648, 0x0631, 0x0629, 0x0020,
    0x0627, 0x0644, 0x0635, 0x064a, 0x0641, 0x064a, 0x0629, 0x0020,
    0x0032, 0x0030, 0x0032, 0x0036,
  ),
  startDate: new Date('2026-06-06T00:00:00.000Z'),
};

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {(line: string) => void} [log]
 * @returns {Promise<'created' | 'unchanged'>}
 */
async function seedTerms(prisma, log = console.log) {
  const existing = await prisma.term.count();

  let outcome = 'unchanged';
  if (existing === 0) {
    // Empty database only. Inside one transaction so a half-seeded state
    // (one course, or none active) can never be left behind.
    await prisma.$transaction(async (tx) => {
      await tx.term.create({
        data: {
          name: WINTER.name,
          nameAr: WINTER.nameAr,
          startDate: new Date('2025-09-01T00:00:00.000Z'),
          endDate: WINTER.endDate,
          isActive: false,
        },
      });
      await tx.term.create({
        data: {
          name: SUMMER.name,
          nameAr: SUMMER.nameAr,
          startDate: SUMMER.startDate,
          endDate: null,
          isActive: true,
        },
      });
    });
    outcome = 'created';
    log('Courses: empty database — created ' + WINTER.name + ' and ' + SUMMER.name + ' (active).');
  }

  const active = await prisma.term.findFirst({ where: { isActive: true } });
  log(
    active
      ? 'Courses: ' + (outcome === 'created' ? '' : existing + ' found, none changed. ') +
          'Active course: ' + active.name + ' (id=' + active.id + ').'
      : 'Courses: WARNING — no active course. Recording points is blocked until an admin activates one.',
  );

  const [orphanRecitations, orphanPoints] = await Promise.all([
    prisma.recitation.count({ where: { termId: null } }),
    prisma.pointsLog.count({ where: { termId: null } }),
  ]);
  if (orphanRecitations > 0 || orphanPoints > 0) {
    log('Courses: WARNING — rows without a course: recitations=' + orphanRecitations + ', points=' + orphanPoints + '.');
  }
  return outcome;
}

module.exports = { seedTerms };

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  seedTerms(prisma)
    .catch((err) => {
      // Never block the API from starting.
      console.error('Course seed check failed (boot continues):', err && err.message ? err.message : err);
    })
    .finally(() => prisma.$disconnect());
}
