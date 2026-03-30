import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash('TaqwaAdmin@2026!', 12);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: password,
      role: 'ADMIN',
      isActive: true,
    },
  });

  console.log('Admin created:', admin.id);

  const categories = [
    { name: 'Quran Page Memorization', nameAr: 'حفظ صفحة قرآن', type: 'EARN' as const, defaultValue: 10, hasRating: true },
    { name: 'Religious Text', nameAr: 'حفظ نص ديني', type: 'EARN' as const, defaultValue: 7, hasRating: true },
    { name: 'Complete Juz', nameAr: 'إتمام جزء كامل', type: 'EARN' as const, defaultValue: 50, hasRating: false },
    { name: 'Proper Dress', nameAr: 'حسن المظهر', type: 'EARN' as const, defaultValue: 2, hasRating: false },
    { name: 'Polite Behavior', nameAr: 'حسن السلوك', type: 'EARN' as const, defaultValue: 2, hasRating: false },
    { name: 'Monthly Quiz', nameAr: 'اجتياز الاختبار', type: 'EARN' as const, defaultValue: 15, hasRating: false },
    { name: 'Recruit Student', nameAr: 'إحضار طالب جديد', type: 'EARN' as const, defaultValue: 15, hasRating: false },
    { name: 'Disruptive', nameAr: 'إزعاج أثناء الدرس', type: 'DEDUCT' as const, defaultValue: 3, hasRating: false },
    { name: 'Absence', nameAr: 'غياب', type: 'DEDUCT' as const, defaultValue: 5, hasRating: false },
    { name: 'Late Arrival', nameAr: 'تأخر', type: 'DEDUCT' as const, defaultValue: 2, hasRating: false },
    { name: 'Phone Use', nameAr: 'استخدام الهاتف', type: 'DEDUCT' as const, defaultValue: 3, hasRating: false },
  ];

  for (const cat of categories) {
    await prisma.pointCategory.create({ data: cat });
  }

  console.log('Seeded', categories.length, 'point categories');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
