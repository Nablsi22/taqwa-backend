const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  // Create admin
  const hash = await bcrypt.hash('admin123', 12);
  try {
    await prisma.user.create({
      data: { username: 'admin', passwordHash: hash, role: 'ADMIN' },
    });
    console.log('Admin created (admin / admin123)');
  } catch (e) {
    console.log('Admin already exists or error:', e.message);
  }

  // Create point categories
  const cats = [
    { name: 'Quran Page Memorization', nameAr: 'حفظ صفحة قرآن', type: 'EARN', defaultValue: 10, hasRating: true },
    { name: 'Good Behavior', nameAr: 'حسن السلوك', type: 'EARN', defaultValue: 5, hasRating: false },
    { name: 'Attendance Bonus', nameAr: 'مكافأة الحضور', type: 'EARN', defaultValue: 3, hasRating: false },
    { name: 'Late Arrival', nameAr: 'التأخر', type: 'DEDUCT', defaultValue: 2, hasRating: false },
    { name: 'Absence', nameAr: 'الغياب', type: 'DEDUCT', defaultValue: 5, hasRating: false },
    { name: 'Bad Behavior', nameAr: 'سوء السلوك', type: 'DEDUCT', defaultValue: 5, hasRating: false },
  ];

  for (const c of cats) {
    try {
      await prisma.pointCategory.create({ data: c });
      console.log('Created category: ' + c.nameAr);
    } catch (e) {
      console.log('Category exists or error: ' + c.nameAr);
    }
  }

  console.log('\nDone! Admin + 6 categories seeded.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
