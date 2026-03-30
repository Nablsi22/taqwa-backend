import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RULES = [
  // ═══ AUTO: Attendance ═══
  {
    code: 'ATTEND_ON_TIME',
    nameAr: 'الحضور على الموعد',
    description: 'يُضاف تلقائياً عند تسجيل الحضور',
    points: 5,
    isPerPage: false,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'ABSENT',
    nameAr: 'الغياب',
    description: 'يُخصم تلقائياً عند تسجيل الغياب (بدون وجود عذر وتواصل الأهل مع الأساتذة)',
    points: -5,
    isPerPage: false,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'LATE',
    nameAr: 'التأخر',
    description: 'يُخصم تلقائياً عند تسجيل التأخر (حتى 10 دقائق بدون وجود عذر)',
    points: -2,
    isPerPage: false,
    isAutomatic: true,
    isDeletable: false,
  },

  // ═══ AUTO: Recitation ═══
  {
    code: 'RECITE_GOOD',
    nameAr: 'تسميع صفحة بتقدير جيد',
    description: '+1 على كل صفحة',
    points: 1,
    isPerPage: true,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'RECITE_VERY_GOOD',
    nameAr: 'تسميع صفحة بتقدير جيد جداً',
    description: '+2 على كل صفحة',
    points: 2,
    isPerPage: true,
    isAutomatic: true,
    isDeletable: false,
  },
  {
    code: 'RECITE_5PLUS_PAGES',
    nameAr: 'تسميع 5+ صفحات',
    description: '+3 على كل صفحة (يُلغي القاعدة الأقل)',
    points: 3,
    isPerPage: true,
    minPages: 5,
    isAutomatic: true,
    isDeletable: false,
  },

  // ═══ MANUAL: Earn ═══
  {
    code: 'NEAT_DRESS',
    nameAr: 'اللباس الأنيق',
    points: 1,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'BRING_NEW_STUDENT',
    nameAr: 'الحضور مع أخ جديد',
    description: 'بشرط الحضور شهر فأكثر',
    points: 15,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'FULL_ATTENDANCE',
    nameAr: 'الالتزام بالحضور كامل الدورة',
    points: 20,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },

  // ═══ MANUAL: AWKAF exams ═══
  {
    code: 'AWKAF_EXCELLENT',
    nameAr: 'السبر بالأوقاف بتقدير ممتاز',
    points: 35,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'AWKAF_VERY_GOOD',
    nameAr: 'السبر بالأوقاف بتقدير جيد جداً',
    points: 30,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'AWKAF_GOOD',
    nameAr: 'السبر بالأوقاف بتقدير جيد',
    points: 25,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },

  // ═══ MANUAL: Deduct ═══
  {
    code: 'PHONE_USE',
    nameAr: 'استخدام الموبايل بدون إذن',
    points: -5,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },
  {
    code: 'DISOBEY_RULES',
    nameAr: 'شغب وعدم الالتزام بقوانين المسجد',
    points: -5,
    isPerPage: false,
    isAutomatic: false,
    isDeletable: false,
  },

  {
    code: 'RECITE_MAQRAA',
    nameAr: 'مقرأة جماعية',
    description: 'نقاط جزئية للقراءة الجماعية مع المعلم',
    points: 1,
    isPerPage: true,
    isAutomatic: true,
    isDeletable: false,
  },
];

async function main() {
  console.log('Seeding point rules...');

  for (const rule of RULES) {
    await prisma.pointRule.upsert({
      where: { code: rule.code },
      update: {
        nameAr: rule.nameAr,
        description: rule.description || null,
        isPerPage: rule.isPerPage,
        minPages: rule.minPages || null,
        isAutomatic: rule.isAutomatic,
        isDeletable: rule.isDeletable,
      },
      create: {
        code: rule.code,
        nameAr: rule.nameAr,
        description: rule.description || null,
        points: rule.points,
        isPerPage: rule.isPerPage,
        minPages: rule.minPages || null,
        isAutomatic: rule.isAutomatic,
        isDeletable: rule.isDeletable,
      },
    });
    console.log(`  done ${rule.code} => ${rule.nameAr} (${rule.points > 0 ? '+' : ''}${rule.points})`);
  }

  console.log(`\nDone! ${RULES.length} rules seeded.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
