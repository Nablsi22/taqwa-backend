// ═══════════════════════════════════════════════════════════════════════════
// prisma/seed_admin.js
//
// Runs on EVERY container start (Dockerfile CMD). Idempotent:
//   • the admin user is created only if the username does not exist yet —
//     an existing admin, and its password, are never touched;
//   • each default point category is created only if no category with the
//     same name and type exists yet.
//
// The previous version created the six categories unconditionally (their id
// is a fresh uuid, so nothing ever conflicted): every boot added six more
// copies. Existing duplicates are left exactly as they are — points rows
// reference them — this only stops new ones from appearing.
//
// It never fails the boot: errors are logged and the process exits 0.
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CATEGORIES = [
  { name: 'Quran Page Memorization', nameAr: 'حفظ صفحة قرآن', type: 'EARN', defaultValue: 10, hasRating: true },
  { name: 'Good Behavior', nameAr: 'حسن السلوك', type: 'EARN', defaultValue: 5, hasRating: false },
  { name: 'Attendance Bonus', nameAr: 'مكافأة الحضور', type: 'EARN', defaultValue: 3, hasRating: false },
  { name: 'Late Arrival', nameAr: 'التأخر', type: 'DEDUCT', defaultValue: 2, hasRating: false },
  { name: 'Absence', nameAr: 'الغياب', type: 'DEDUCT', defaultValue: 5, hasRating: false },
  { name: 'Bad Behavior', nameAr: 'سوء السلوك', type: 'DEDUCT', defaultValue: 5, hasRating: false },
];

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {(password: string) => Promise<string>} hashPassword
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ adminCreated: boolean; categoriesCreated: number }>}
 */
async function seedAdmin(prisma, hashPassword, log = console.log) {
  let adminCreated = false;
  const admin = await prisma.user.findUnique({ where: { username: 'admin' }, select: { id: true } });
  if (!admin) {
    await prisma.user.create({
      data: { username: 'admin', passwordHash: await hashPassword('admin123'), role: 'ADMIN' },
    });
    adminCreated = true;
    log('Admin created (admin / admin123) — change this password.');
  }

  let categoriesCreated = 0;
  for (const c of DEFAULT_CATEGORIES) {
    const exists = await prisma.pointCategory.findFirst({
      where: { name: c.name, type: c.type },
      select: { id: true },
    });
    if (!exists) {
      await prisma.pointCategory.create({ data: c });
      categoriesCreated += 1;
      log('Created category: ' + c.nameAr);
    }
  }
  log('Seed: admin ' + (adminCreated ? 'created' : 'exists') + ', ' + categoriesCreated + ' new categories.');
  return { adminCreated, categoriesCreated };
}

module.exports = { seedAdmin, DEFAULT_CATEGORIES };

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  const bcrypt = require('bcrypt');
  const prisma = new PrismaClient();
  seedAdmin(prisma, (p) => bcrypt.hash(p, 12))
    .catch((err) => {
      // Never block the API from starting.
      console.error('Admin seed failed (boot continues):', err && err.message ? err.message : err);
    })
    .finally(() => prisma.$disconnect());
}
