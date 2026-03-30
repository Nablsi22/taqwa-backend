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
  // POINTS — Auto-apply based on rating
  // ═══════════════════════════════════════════════════════════

  private async applyRecitationPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pageCount: number,
  ) {
    if (rating === 'REPEAT' || rating === 'DID_NOT_MEMORIZE' || pageCount <= 0) {
      return;
    }

    if (rating === 'MAQRAA') {
      return;
    }

    const pointResult = await this.pointRulesService.getRecitationPoints(
      rating,
      pageCount,
    );

    if (pointResult && pointResult.points > 0) {
      let category = await this.prisma.pointCategory.findFirst({
        where: { name: 'recitation' },
      });
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
  }

  // ═══════════════════════════════════════════════════════════
  // STUDENT PROGRESS — Cumulative sura tracking (FIXED)
  // ═══════════════════════════════════════════════════════════

  /**
   * Get a student's complete memorization progress across all suras.
   * Returns per-sura progress and overall percentage.
   *
   * FIX: isCompleteSura entries now correctly count their pages
   *      toward the total. Previously, the if/else chain skipped
   *      page accumulation when isCompleteSura was true, causing 0%.
   */
  async getStudentProgress(studentId: string) {
    const recitations = await this.prisma.recitation.findMany({
      where: { studentId },
      orderBy: { date: 'asc' },
    });

    // Build per-sura progress
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

      // ── FIX: Count pages for ALL memorization-type entries ──
      if (rec.isCompleteSura) {
        // Complete sura: mark complete AND count pages
        progress.isComplete = true;
        progress.individualPages += rec.pagesRecited;
      } else if (rec.rating === 'VERY_GOOD' || rec.rating === 'GOOD') {
        // Normal recitation: accumulate pages
        progress.individualPages += rec.pagesRecited;
      }
      // MAQRAA, REPEAT, DID_NOT_MEMORIZE → no page credit

      // Always update last date/rating
      progress.lastDate = rec.date;
      progress.lastRating = rec.rating;
    }

    // Build the full 114-sura response
    const suraProgress = SURA_METADATA.map((sura) => {
      const progress = suraProgressMap.get(sura.number);
      const individualPages = progress?.individualPages || 0;

      // Cap at sura's total pages (can't memorize more than 100%)
      const cappedPages = Math.min(individualPages, sura.totalPages);

      // Auto-complete: if accumulated pages >= sura total
      const isComplete =
        progress?.isComplete || individualPages >= sura.totalPages;

      // Sura completion percentage (capped at 100%)
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

    // Overall Quran progress — sum of capped per-sura pages
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

      // ── FIX: Use per-sura capped sum instead of raw aggregate ──
      // This prevents over-counting when a student recites the same
      // sura multiple times beyond its total pages.
      const recitations = await this.prisma.recitation.findMany({
        where: {
          studentId: student.id,
          rating: { in: ['VERY_GOOD', 'GOOD'] },
        },
        select: { surahNumber: true, pagesRecited: true, isCompleteSura: true },
      });

      // Group by sura and cap at each sura's total pages
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
}
