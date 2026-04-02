import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecitationDto, BulkMaqraaDto } from './dto/create-recitation.dto';
import { PointRulesService } from '../point-rules/point-rules.service';
import {
  SURA_METADATA,
  getSuraByNumber,
  getSuraName,
  getSuraTotalPages,
  TOTAL_QURAN_PAGES,
} from '../quran-metadata/quran-metadata';

@Injectable()
export class RecitationService {
  constructor(
    private prisma: PrismaService,
    private pointRulesService: PointRulesService,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // CREATE — Single recitation entry
  // ═══════════════════════════════════════════════════════════

  private async resolveInstructorId(userId: string): Promise<string> {
    const instructor = await this.prisma.instructor.findFirst({
      where: { userId },
    });
    if (instructor) return instructor.id;
    return userId;
  }

  async create(dto: CreateRecitationDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const sura = getSuraByNumber(dto.surahNumber);
    if (!sura) {
      throw new BadRequestException(`رقم السورة غير صالح: ${dto.surahNumber}`);
    }

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const pagesRecited = dto.isCompleteSura
      ? sura.totalPages
      : dto.pagesRecited;

    const recitation = await this.prisma.recitation.create({
      data: {
        studentId: dto.studentId,
        instructorId,
        surahNumber: dto.surahNumber,
        pagesRecited,
        isCompleteSura: dto.isCompleteSura || false,
        rating: dto.rating,
        homework: dto.homework || null,
        date: new Date(dto.date),
      },
    });

    // —— AUTO-POINTS: Apply points based on rating ——
    await this.applyRecitationPoints(
      dto.studentId,
      instructorId,
      dto.rating,
      pagesRecited,
    );

    return {
      data: recitation,
      suraName: sura.nameAr,
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BULK MAQRAA — Group reading for all selected students
  // ═══════════════════════════════════════════════════════════

  async createBulkMaqraa(dto: BulkMaqraaDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const sura = getSuraByNumber(dto.surahNumber);
    if (!sura) {
      throw new BadRequestException(`رقم السورة غير صالح: ${dto.surahNumber}`);
    }

    const results = [];

    for (const studentId of dto.studentIds) {
      const recitation = await this.prisma.recitation.create({
        data: {
          studentId,
          instructorId,
          surahNumber: dto.surahNumber,
          pagesRecited: dto.pagesRecited || 0,
          isCompleteSura: false,
          rating: 'MAQRAA',
          date: new Date(dto.date),
        },
      });

      // —— FIX: MAQRAA now gets points too ——
      await this.applyRecitationPoints(
        studentId,
        instructorId,
        'MAQRAA',
        dto.pagesRecited || 0,
      );

      results.push(recitation);
    }

    return {
      data: results,
      count: results.length,
      suraName: sura.nameAr,
      message: `تم تسجيل المقرأة لـ ${results.length} طالب`,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // POINTS — Auto-apply based on rating (FIXED)
  // ═══════════════════════════════════════════════════════════

  private async applyRecitationPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pageCount: number,
  ) {
    try {
      if (rating === 'REPEAT' || rating === 'DID_NOT_MEMORIZE' || pageCount <= 0) {
        return;
      }

      let pointResult: { points: number; ruleNameAr: string } | null = null;

      if (rating === 'MAQRAA') {
        const maqraaRule = await this.pointRulesService.findByCode('RECITE_MAQRAA');
        if (maqraaRule && maqraaRule.isActive) {
          const pts = maqraaRule.isPerPage
            ? maqraaRule.points * pageCount
            : maqraaRule.points;
          pointResult = { points: pts, ruleNameAr: maqraaRule.nameAr };
        }
      } else {
        pointResult = await this.pointRulesService.getRecitationPoints(
          rating,
          pageCount,
        );
      }

      if (pointResult && pointResult.points !== 0) {
        let category = await this.prisma.pointCategory.findFirst({
          where: { name: { contains: 'Quran', mode: 'insensitive' } },
        });
        if (!category) {
          category = await this.prisma.pointCategory.findFirst({
            where: { name: { contains: 'recitation', mode: 'insensitive' } },
          });
        }
        if (!category) {
          category = await this.prisma.pointCategory.findFirst({
            where: { name: { contains: 'Memorization', mode: 'insensitive' } },
          });
        }
        if (!category) {
          category = await this.prisma.pointCategory.findFirst();
        }

        if (category) {
          await this.prisma.pointsLog.create({
            data: {
              studentId,
              categoryId: category.id,
              amount: Math.round(pointResult.points),
              rating: rating as any,
              description: pointResult.ruleNameAr,
              awardedBy: instructorId,
            },
          });
        }
      }
    } catch (error) {
      console.error('Error applying recitation points:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // STUDENT PROGRESS — Cumulative sura tracking (FIXED)
  // ═══════════════════════════════════════════════════════════

  async getStudentProgress(studentId: string) {
    const recitations = await this.prisma.recitation.findMany({
      where: { studentId },
      orderBy: { date: 'asc' },
    });

    const suraProgressMap = new Map<
      number,
      {
        individualPages: number;
        isComplete: boolean;
        lastDate: Date | null;
        lastRating: string | null;
      }
    >();

    for (const rec of recitations) {
      if (!suraProgressMap.has(rec.surahNumber)) {
        suraProgressMap.set(rec.surahNumber, {
          individualPages: 0,
          isComplete: false,
          lastDate: null,
          lastRating: null,
        });
      }

      const progress = suraProgressMap.get(rec.surahNumber)!;

      if (rec.isCompleteSura) {
        progress.isComplete = true;
        progress.individualPages += rec.pagesRecited;
      } else if (rec.rating === 'VERY_GOOD' || rec.rating === 'GOOD') {
        progress.individualPages += rec.pagesRecited;
      }

      progress.lastDate = rec.date;
      progress.lastRating = rec.rating;
    }

    const suraProgress = SURA_METADATA.map((sura) => {
      const progress = suraProgressMap.get(sura.number);
      const individualPages = progress?.individualPages || 0;
      const cappedPages = Math.min(individualPages, sura.totalPages);
      const isComplete =
        progress?.isComplete || individualPages >= sura.totalPages;
      const percentage = Math.min(
        100,
        Math.round((cappedPages / sura.totalPages) * 100),
      );

      return {
        surahNumber: sura.number,
        suraName: sura.nameAr,
        totalSuraPages: sura.totalPages,
        individualPagesMemorized: cappedPages,
        totalPagesProgress: cappedPages,
        percentage,
        isComplete,
        juz: sura.juzStart,
        lastDate: progress?.lastDate || null,
        lastRating: progress?.lastRating || null,
      };
    });

    const totalPagesMemorized = suraProgress.reduce(
      (sum, s) => sum + s.individualPagesMemorized,
      0,
    );
    const completedSuras = suraProgress.filter((s) => s.isComplete).length;

    return {
      studentId,
      totalPagesMemorized: Math.min(totalPagesMemorized, TOTAL_QURAN_PAGES),
      totalQuranPages: TOTAL_QURAN_PAGES,
      overallPercentage:
        Math.round(
          (Math.min(totalPagesMemorized, TOTAL_QURAN_PAGES) /
            TOTAL_QURAN_PAGES) *
            100 *
            10,
        ) / 10,
      completedSuras,
      totalSuras: 114,
      suraProgress,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // RECITATION HISTORY — For a specific student
  // ═══════════════════════════════════════════════════════════

  async getStudentRecitations(studentId: string) {
    const recitations = await this.prisma.recitation.findMany({
      where: { studentId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    return {
      data: recitations.map((rec) => ({
        ...rec,
        suraName: getSuraName(rec.surahNumber),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // LATEST HOMEWORK — Get the most recent homework for a student
  // ═══════════════════════════════════════════════════════════

  async getStudentHomework(studentId: string) {
    const latestWithHomework = await this.prisma.recitation.findFirst({
      where: {
        studentId,
        homework: { not: null },
        NOT: { homework: '' },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    if (!latestWithHomework) {
      return { homework: null, date: null, suraName: null };
    }

    return {
      homework: latestWithHomework.homework,
      date: latestWithHomework.date,
      suraName: getSuraName(latestWithHomework.surahNumber),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // INSTRUCTOR OVERVIEW — All students' progress (FIXED)
  // ═══════════════════════════════════════════════════════════

  async getInstructorOverview(instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const students = await this.prisma.student.findMany({
      where: { instructorId },
      include: { user: true },
    });

    const overview = [];

    for (const student of students) {
      const lastRecitation = await this.prisma.recitation.findFirst({
        where: { studentId: student.id },
        orderBy: { date: 'desc' },
      });

      const recitations = await this.prisma.recitation.findMany({
        where: {
          studentId: student.id,
          rating: { in: ['VERY_GOOD', 'GOOD'] },
        },
        select: { surahNumber: true, pagesRecited: true, isCompleteSura: true },
      });

      const suraPages = new Map<number, number>();
      for (const rec of recitations) {
        const current = suraPages.get(rec.surahNumber) || 0;
        suraPages.set(rec.surahNumber, current + rec.pagesRecited);
      }

      let totalPages = 0;
      for (const [surahNumber, pages] of suraPages) {
        const sura = getSuraByNumber(surahNumber);
        const cap = sura ? sura.totalPages : pages;
        totalPages += Math.min(pages, cap);
      }

      overview.push({
        studentId: student.id,
        fullName: student.fullName,
        totalPagesMemorized: totalPages,
        overallPercentage:
          Math.round((totalPages / TOTAL_QURAN_PAGES) * 100 * 10) / 10,
        lastSurah: lastRecitation?.surahNumber || null,
        lastSurahName: lastRecitation
          ? getSuraName(lastRecitation.surahNumber)
          : null,
        lastRating: lastRecitation?.rating || null,
        lastDate: lastRecitation?.date || null,
        homework: lastRecitation?.homework || null,
      });
    }

    return { data: overview };
  }

  // ═══════════════════════════════════════════════════════════
  // QURAN METADATA — Exposed for frontend sura picker
  // ═══════════════════════════════════════════════════════════

  getSuraList() {
    return {
      data: SURA_METADATA.map((s) => ({
        number: s.number,
        nameAr: s.nameAr,
        totalPages: s.totalPages,
        juz: s.juzStart,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // DELETE RECITATION — Admin only
  // ═══════════════════════════════════════════════════════════

  async deleteRecitation(id: string) {
    const recitation = await this.prisma.recitation.findUnique({
      where: { id },
    });

    if (!recitation) {
      throw new NotFoundException('سجل التسميع غير موجود');
    }

    await this.prisma.recitation.delete({
      where: { id },
    });

    return { message: 'تم حذف سجل التسميع بنجاح' };
  }
}
