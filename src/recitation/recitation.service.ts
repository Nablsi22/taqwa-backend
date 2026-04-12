import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateRecitationDto,
  BulkMaqraaDto,
} from './dto/create-recitation.dto';
import { PointRulesService } from '../point-rules/point-rules.service';
import {
  SURA_METADATA,
  getSuraByNumber,
  getSuraName,
  TOTAL_QURAN_PAGES,
} from '../quran-metadata/quran-metadata';
import {
  calculatePages,
  calculatePoints,
  validateRange,
  getSurahMeta,
} from '../quran-metadata/quran-ayat-pages.util';

@Injectable()
export class RecitationService {
  constructor(
    private prisma: PrismaService,
    private pointRulesService: PointRulesService,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════

  private async resolveInstructorId(userId: string): Promise<string> {
    const instructor = await this.prisma.instructor.findFirst({
      where: { userId },
    });
    if (instructor) return instructor.id;
    return userId;
  }

  private surahNumsOf(rec: {
    surahNumbers: number[] | null;
    surahNumber: number;
  }): number[] {
    if (rec.surahNumbers && rec.surahNumbers.length > 0) {
      return rec.surahNumbers;
    }
    return [rec.surahNumber];
  }

  // ═══════════════════════════════════════════════════════════
  // CREATE — handles BOTH new aya-range and legacy formats
  // ═══════════════════════════════════════════════════════════

  async create(dto: CreateRecitationDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) throw new NotFoundException('الطالب غير موجود');

    const isNewFormat =
      dto.startSurah !== undefined && dto.startAya !== undefined;

    // ════════════════ NEW aya-range path ════════════════
    if (isNewFormat) {
      const startSurah = dto.startSurah!;
      const endSurah = dto.endSurah ?? startSurah;
      const startAya = dto.startAya!;
      const endAya = dto.endAya ?? startAya;

      if (endSurah !== startSurah) {
        throw new BadRequestException('يُسمح فقط بنطاق ضمن سورة واحدة');
      }
      const v = validateRange(startSurah, startAya, endSurah, endAya);
      if (!v.valid) throw new BadRequestException(v.error);

      const pages = calculatePages(startSurah, startAya, endSurah, endAya);
      const pagesDec = new Prisma.Decimal(pages.toFixed(3));
      const surahMeta = getSurahMeta(startSurah)!;

      const recitation = await this.prisma.recitation.create({
        data: {
          studentId: dto.studentId,
          instructorId,
          surahNumber: startSurah,         // legacy mirror
          surahNumbers: [startSurah],      // legacy mirror
          pagesRecited: Math.max(1, Math.round(pages)), // legacy int mirror
          isCompleteSura:
            startAya === 1 && endAya >= surahMeta.numAyas,
          rating: dto.rating,
          homework: dto.homework || null,
          date: new Date(dto.date),
          startSurah,
          startAya,
          endSurah,
          endAya,
          pagesCalculated: pagesDec,
        },
      });

      await this.applyNewFormatPoints(
        dto.studentId,
        instructorId,
        dto.rating,
        pages,
        recitation.id,
      );

      return {
        data: { ...recitation, suraNames: [surahMeta.nameAr] },
        suraName: surahMeta.nameAr,
        message: 'تم تسجيل التسميع بنجاح',
      };
    }

    // ════════════════ LEGACY multi-surah path ════════════════
    if (!dto.surahNumbers || dto.surahNumbers.length === 0) {
      throw new BadRequestException('surahNumbers مطلوب');
    }
    for (const n of dto.surahNumbers) {
      if (!getSuraByNumber(n)) {
        throw new BadRequestException(`رقم السورة غير صالح: ${n}`);
      }
    }

    const isMulti = dto.surahNumbers.length > 1;
    let pagesRecited: number;

    if (isMulti) {
      pagesRecited = dto.surahNumbers.reduce((sum, n) => {
        const s = getSuraByNumber(n);
        return sum + (s?.totalPages ?? 0);
      }, 0);
      pagesRecited = Math.round(pagesRecited * 100) / 100;
    } else {
      pagesRecited = dto.pagesRecited ?? 0;
    }

    const primarySurah = dto.surahNumbers[0];

    const recitation = await this.prisma.recitation.create({
      data: {
        studentId: dto.studentId,
        instructorId,
        surahNumber: primarySurah,
        surahNumbers: dto.surahNumbers,
        pagesRecited,
        isCompleteSura: isMulti,
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
      recitation.id,
    );

    const suraNames = dto.surahNumbers.map((n) => getSuraName(n));

    return {
      data: { ...recitation, suraNames },
      suraName: suraNames.join('، '),
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BULK MAQRAA — unchanged
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
          surahNumbers: [dto.surahNumber],
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
        recitation.id,
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
  // POINTS — NEW format (decimal, exact)
  // ═══════════════════════════════════════════════════════════

  private async applyNewFormatPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pages: number,
    sourceId: string,
  ) {
    try {
      const amount = calculatePoints(pages, rating);
      if (!amount || amount <= 0) return;

      const category =
        (await this.prisma.pointCategory.findFirst({
          where: { name: { contains: 'Quran', mode: 'insensitive' } },
        })) ||
        (await this.prisma.pointCategory.findFirst({
          where: { name: { contains: 'recitation', mode: 'insensitive' } },
        })) ||
        (await this.prisma.pointCategory.findFirst({
          where: { name: { contains: 'Memorization', mode: 'insensitive' } },
        })) ||
        (await this.prisma.pointCategory.findFirst());

      if (!category) return;

      await this.prisma.pointsLog.create({
        data: {
          studentId,
          categoryId: category.id,
          amount: new Prisma.Decimal(amount.toFixed(3)),
          rating: rating as any,
          description: `تسميع ${pages.toFixed(2)} صفحة — ${rating}`,
          awardedBy: instructorId,
          sourceId,
          sourceType: 'RECITATION',
        },
      });
    } catch (error) {
      console.error('Error applying new-format recitation points:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // POINTS — LEGACY format (unchanged behavior)
  // ═══════════════════════════════════════════════════════════

  private async applyRecitationPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pageCount: number,
    sourceId: string,
  ) {
    try {
      if (
        rating === 'REPEAT' ||
        rating === 'DID_NOT_MEMORIZE' ||
        pageCount <= 0
      ) {
        return;
      }

      let pointResult: { points: number; ruleNameAr: string } | null = null;

      if (rating === 'MAQRAA') {
        const maqraaRule =
          await this.pointRulesService.findByCode('RECITE_MAQRAA');
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
        const category =
          (await this.prisma.pointCategory.findFirst({
            where: { name: { contains: 'Quran', mode: 'insensitive' } },
          })) ||
          (await this.prisma.pointCategory.findFirst({
            where: { name: { contains: 'recitation', mode: 'insensitive' } },
          })) ||
          (await this.prisma.pointCategory.findFirst({
            where: { name: { contains: 'Memorization', mode: 'insensitive' } },
          })) ||
          (await this.prisma.pointCategory.findFirst());

        if (category) {
          await this.prisma.pointsLog.create({
            data: {
              studentId,
              categoryId: category.id,
              amount: new Prisma.Decimal(pointResult.points.toFixed(3)),
              rating: rating as any,
              description: pointResult.ruleNameAr,
              awardedBy: instructorId,
              sourceId,
              sourceType: 'RECITATION',
            },
          });
        }
      }
    } catch (error) {
      console.error('Error applying recitation points:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // NEXT-AYA SUGGESTION
  // ═══════════════════════════════════════════════════════════

  async getNextSuggestion(studentId: string) {
    const last = await this.prisma.recitation.findFirst({
      where: {
        studentId,
        rating: { notIn: ['REPEAT', 'DID_NOT_MEMORIZE', 'MAQRAA'] },
        endSurah: { not: null },
        endAya: { not: null },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    if (!last || !last.endSurah || !last.endAya) {
      const meta = getSurahMeta(1)!;
      return {
        suggestedSurah: 1,
        suggestedAya: 1,
        suggestedSurahName: meta.nameAr,
      };
    }

    const meta = getSurahMeta(last.endSurah)!;
    if (last.endAya >= meta.numAyas) {
      const next = Math.min(114, last.endSurah + 1);
      const nextMeta = getSurahMeta(next)!;
      return {
        suggestedSurah: next,
        suggestedAya: 1,
        suggestedSurahName: nextMeta.nameAr,
      };
    }
    return {
      suggestedSurah: last.endSurah,
      suggestedAya: last.endAya + 1,
      suggestedSurahName: meta.nameAr,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // STUDENT PROGRESS — aya-union for new format, legacy fallback
  // ═══════════════════════════════════════════════════════════

  async getStudentProgress(studentId: string) {
    const recitations = await this.prisma.recitation.findMany({
      where: { studentId },
      orderBy: { date: 'asc' },
    });

    type SuraProgress = {
      individualPages: number;
      ayaUnion: Set<number>;
      isComplete: boolean;
      lastDate: Date | null;
      lastRating: string | null;
    };

    const suraProgressMap = new Map<number, SuraProgress>();

    for (const rec of recitations) {
      const surahNums = this.surahNumsOf(rec);
      const isMulti = surahNums.length > 1;
      const isAyaRange =
        rec.startAya != null &&
        rec.endAya != null &&
        rec.startSurah != null &&
        rec.endSurah != null &&
        rec.startSurah === rec.endSurah;

      for (const surahNum of surahNums) {
        if (!suraProgressMap.has(surahNum)) {
          suraProgressMap.set(surahNum, {
            individualPages: 0,
            ayaUnion: new Set(),
            isComplete: false,
            lastDate: null,
            lastRating: null,
          });
        }

        const progress = suraProgressMap.get(surahNum)!;
        const sura = getSuraByNumber(surahNum);

        if (rec.rating === 'VERY_GOOD' || rec.rating === 'GOOD') {
          // ── NEW: aya-range entry ──
          if (isAyaRange && rec.startSurah === surahNum) {
            for (let a = rec.startAya!; a <= rec.endAya!; a++) {
              progress.ayaUnion.add(a);
            }
            const meta = getSurahMeta(surahNum);
            if (meta && progress.ayaUnion.size >= meta.numAyas) {
              progress.isComplete = true;
            }
          }
          // ── LEGACY: multi-surah ──
          else if (isMulti) {
            progress.individualPages += sura?.totalPages ?? 0;
            progress.isComplete = true;
          }
          // ── LEGACY: single-surah pages ──
          else {
            progress.individualPages += rec.pagesRecited;
            if (
              rec.isCompleteSura ||
              progress.individualPages >= (sura?.totalPages ?? Infinity)
            ) {
              progress.isComplete = true;
            }
          }
        }

        progress.lastDate = rec.date;
        progress.lastRating = rec.rating;
      }
    }

    const suraProgress = SURA_METADATA.map((sura) => {
      const progress = suraProgressMap.get(sura.number);
      const meta = getSurahMeta(sura.number);
      const numAyas = meta?.numAyas ?? 0;

      // Legacy contribution
      const legacyPages = Math.min(
        progress?.individualPages || 0,
        sura.totalPages,
      );
      const legacyPct =
        sura.totalPages > 0 ? (legacyPages / sura.totalPages) * 100 : 0;

      // New-format contribution
      const ayaCount = progress?.ayaUnion.size || 0;
      const ayaPct = numAyas > 0 ? (ayaCount / numAyas) * 100 : 0;
      const ayaPages = (ayaPct / 100) * sura.totalPages;

      // Take the larger source
      const rawPct = Math.max(legacyPct, ayaPct);
      const percentage =
        Math.min(100, Math.round(rawPct * 10) / 10);
      const cappedPages = Math.max(legacyPages, ayaPages);
      const isComplete =
        progress?.isComplete ||
        legacyPages >= sura.totalPages ||
        (numAyas > 0 && ayaCount >= numAyas);

      return {
        surahNumber: sura.number,
        suraName: sura.nameAr,
        totalSuraPages: sura.totalPages,
        individualPagesMemorized: Math.round(cappedPages * 100) / 100,
        totalPagesProgress: Math.round(cappedPages * 100) / 100,
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
    const cappedTotal = Math.min(totalPagesMemorized, TOTAL_QURAN_PAGES);

    return {
      studentId,
      totalPagesMemorized: Math.round(cappedTotal * 100) / 100,
      totalQuranPages: TOTAL_QURAN_PAGES,
      overallPercentage:
        Math.round((cappedTotal / TOTAL_QURAN_PAGES) * 100 * 10) / 10,
      completedSuras,
      totalSuras: 114,
      suraProgress,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // RECITATION HISTORY — unchanged
  // ═══════════════════════════════════════════════════════════

  async getStudentRecitations(studentId: string) {
    const recitations = await this.prisma.recitation.findMany({
      where: { studentId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    return {
      data: recitations.map((rec) => {
        const surahNums = this.surahNumsOf(rec);
        const suraNames = surahNums.map((n) => getSuraName(n));
        return {
          ...rec,
          surahNumbers: surahNums,
          suraName: suraNames.join('، '),
          suraNames,
        };
      }),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // LATEST HOMEWORK — unchanged
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

    const surahNums = this.surahNumsOf(latestWithHomework);
    const suraNames = surahNums.map((n) => getSuraName(n));

    return {
      homework: latestWithHomework.homework,
      date: latestWithHomework.date,
      suraName: suraNames.join('، '),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // INSTRUCTOR OVERVIEW — unchanged
  // ═══════════════════════════════════════════════════════════

  async getInstructorOverview(instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const students = await this.prisma.student.findMany({
      where: { instructorId, deletedAt: null },
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
        select: {
          surahNumber: true,
          surahNumbers: true,
          pagesRecited: true,
          isCompleteSura: true,
        },
      });

      const suraPages = new Map<number, number>();
      for (const rec of recitations) {
        const nums = this.surahNumsOf(rec);
        if (nums.length > 1) {
          for (const n of nums) {
            const sura = getSuraByNumber(n);
            const current = suraPages.get(n) || 0;
            suraPages.set(n, current + (sura?.totalPages || 0));
          }
        } else {
          const n = nums[0];
          const current = suraPages.get(n) || 0;
          suraPages.set(n, current + rec.pagesRecited);
        }
      }

      let totalPages = 0;
      for (const [surahNumber, pages] of suraPages) {
        const sura = getSuraByNumber(surahNumber);
        const cap = sura ? sura.totalPages : pages;
        totalPages += Math.min(pages, cap);
      }

      const lastNums = lastRecitation ? this.surahNumsOf(lastRecitation) : [];
      const lastNames = lastNums.map((n) => getSuraName(n));

      overview.push({
        studentId: student.id,
        fullName: student.fullName,
        totalPagesMemorized: totalPages,
        overallPercentage:
          Math.round((totalPages / TOTAL_QURAN_PAGES) * 100 * 10) / 10,
        lastSurah: lastRecitation?.surahNumber || null,
        lastSurahName: lastNames.length > 0 ? lastNames.join('، ') : null,
        lastRating: lastRecitation?.rating || null,
        lastDate: lastRecitation?.date || null,
        homework: lastRecitation?.homework || null,
      });
    }

    return { data: overview };
  }

  // ═══════════════════════════════════════════════════════════
  // QURAN METADATA
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
  // DELETE — unchanged
  // ═══════════════════════════════════════════════════════════

  async deleteRecitation(id: string) {
    const recitation = await this.prisma.recitation.findUnique({
      where: { id },
    });
    if (!recitation) throw new NotFoundException('سجل التسميع غير موجود');

    const result = await this.prisma.$transaction(async (tx) => {
      const deletedPoints = await tx.pointsLog.deleteMany({
        where: { sourceType: 'RECITATION', sourceId: id },
      });
      await tx.recitation.delete({ where: { id } });
      return { deletedPointsCount: deletedPoints.count };
    });

    return {
      message:
        result.deletedPointsCount > 0
          ? `تم حذف التسميع وإلغاء ${result.deletedPointsCount} نقطة مرتبطة به`
          : 'تم حذف التسميع بنجاح',
    };
  }
}