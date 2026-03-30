const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const RULES = [
  // ═══ AUTO: Attendance ═══
  {
    code: 'ATTEND_ON_TIME',
    nameAr: 'الحضور على الموعد',
    description: 'يُضاف تلقائياً عند تسجيل الحضور',
    points: 5,
    isPerPage: false,
    minPages: null,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'ABSENT',
    nameAr: 'الغياب',
    description: 'يُخصم تلقائياً عند تسجيل الغياب',
    points: -5,
    isPerPage: false,
    minPages: null,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'LATE',
    nameAr: 'التأخر',
    description: 'يُخصم تلقائياً عند تسجيل التأخر',
    points: -2,
    isPerPage: false,
    minPages: null,
    isAutomatic: true,
    isDeletable: false,
  },

  // ═══ AUTO: Recitation ═══
  {
    code: 'RECITE_GOOD',
    nameAr: 'تسميع صفحة بتقدير جيد',
    description: '+1 نقطة على كل صفحة',
    points: 1,
    isPerPage: true,
    minPages: null,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'RECITE_VERY_GOOD',
    nameAr: 'تسميع صفحة بتقدير جيد جداً',
    description: '+2 نقطة على كل صفحة',
    points: 2,
    isPerPage: true,
    minPages: null,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'RECITE_5PLUS_PAGES',
    nameAr: 'تسميع 5+ صفحات',
    description: '+3 نقاط على كل صفحة (يُلغي القاعدة الأقل)',
    points: 3,
    isPerPage: true,
    minPages: 5,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'RECITE_MAQRAA',
    nameAr: 'مقرأة جماعية',
    description: 'نقاط جزئية للقراءة الجماعية مع المعلم',
    points: 1,
    isPerPage: true,
    minPages: null,
    isAutomatic: true,
    isDeletable: false,
  },

  // ═══ MANUAL: Earn ═══
  {
    code: 'NEAT_DRESS',
    nameAr: 'اللباس الأنيق',
    description: null,
    points: 1,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'BRING_NEW_STUDENT',
    nameAr: 'الحضور مع أخ جديد',
    description: 'بشرط الحضور شهر فأكثر',
    points: 15,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'FULL_ATTENDANCE',
    nameAr: 'الالتزام بالحضور كامل الدورة',
    description: null,
    points: 20,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },

  // ═══ MANUAL: AWKAF Exams ═══
  {
    code: 'AWKAF_EXCELLENT',
    nameAr: 'السبر بالأوقاف بتقدير ممتاز',
    description: null,
    points: 35,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'AWKAF_VERY_GOOD',
    nameAr: 'السبر بالأوقاف بتقدير جيد جداً',
    description: null,
    points: 30,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'AWKAF_GOOD',
    nameAr: 'السبر بالأوقاف بتقدير جيد',
    description: null,
    points: 25,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },

  // ═══ MANUAL: Deduct ═══
  {
    code: 'PHONE_USE',
    nameAr: 'استخدام الموبايل بدون إذن',
    description: null,
    points: -5,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'DISOBEY_RULES',
    nameAr: 'شغب وعدم الالتزام بقوانين المسجد',
    description: null,
    points: -5,
    isPerPage: false,
    minPages: null,
    isAutomatic: false,
    isDeletable: false,
  },
];

async function main() {
  console.log('Seeding point rules...');
  console.log('Database URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

  let created = 0;
  let updated = 0;

  for (const rule of RULES) {
    try {
      const existing = await prisma.pointRule.findUnique({
        where: { code: rule.code },
      });

      if (existing) {
        await prisma.pointRule.update({
          where: { code: rule.code },
          data: {
            nameAr: rule.nameAr,
            description: rule.description,
            isPerPage: rule.isPerPage,
            minPages: rule.minPages,
            isAutomatic: rule.isAutomatic,
            isDeletable: rule.isDeletable,
          },
        });
        console.log('  ~ UPDATED:', rule.code, '->', rule.nameAr, '(' + (rule.points > 0 ? '+' : '') + rule.points + ')');
        updated++;
      } else {
        await prisma.pointRule.create({
          data: {
            code: rule.code,
            nameAr: rule.nameAr,
            description: rule.description,
            points: rule.points,
            isPerPage: rule.isPerPage,
            minPages: rule.minPages,
            isAutomatic: rule.isAutomatic,
            isDeletable: rule.isDeletable,
          },
        });
        console.log('  + CREATED:', rule.code, '->', rule.nameAr, '(' + (rule.points > 0 ? '+' : '') + rule.points + ')');
        created++;
      }
    } catch (err) {
      console.error('  X ERROR on', rule.code, ':', err.message);
    }
  }

  console.log('\nDone! Created:', created, '| Updated:', updated, '| Total:', RULES.length);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
