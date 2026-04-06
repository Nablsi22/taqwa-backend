import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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

  /**
   * Backward-compat reader: prefer the new `surahNumbers` array,
   * fall back to `[surahNumber]` for legacy rows.
   */
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
  // CREATE — Single recitation entry (supports multi-surah)
  // ═══════════════════════════════════════════════════════════

  async create(dto: CreateRecitationDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    // Validate all surah numbers
    for (const n of dto.surahNumbers) {
      if (!getSuraByNumber(n)) {
        throw new BadRequestException(`رقم السورة غير صالح: ${n}`);
      }
    }

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    // Determine pages: multi-select uses auto sum, single-select uses DTO value
    const isMulti = dto.surahNumbers.length > 1;
    let pagesRecited: number;

    if (isMulti) {
      // Sum of real mushaf pages for every selected surah
      pagesRecited = dto.surahNumbers.reduce((sum, n) => {
        const s = getSuraByNumber(n);
        return sum + (s?.totalPages ?? 0);
      }, 0);
      // Round to 2 decimals to keep numbers clean
      pagesRecited = Math.round(pagesRecited * 100) / 100;
    } else {
      // Single-surah: honor whatever the instructor entered (supports partial)
      pagesRecited = dto.pagesRecited;
    }

    const primarySurah = dto.surahNumbers[0];

    const recitation = await this.prisma.recitation.create({
      data: {
        studentId: dto.studentId,
        instructorId,
        surahNumber: primarySurah, // backward compat
        surahNumbers: dto.surahNumbers, // new source of truth
        pagesRecited,
        isCompleteSura: isMulti, // multi-select implies each full
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

    const suraNames = dto.surahNumbers.map((n) => getSuraName(n));

    return {
      data: {
        ...recitation,
        suraNames,
      },
      suraName: suraNames.join('، '),
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ═══════════════════════════════════════════════════════════
  // BULK MAQRAA — unchanged (single-surah group activity)
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
  // POINTS — Auto-apply based on rating (unchanged)
  // ═══════════════════════════════════════════════════════════

  private async applyRecitationPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pageCount: number,
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
  // STUDENT PROGRESS — updated for multi-surah entries
  // ═══════════════════════════════════════════════════════════

  async getStudentProgress(studentId: string) {
    const recitations = await this.prisma.recitation.findMany({
      where: { studentId },
      orderBy: { date: 'asc' },
    });

    type SuraProgress = {
      individualPages: number;
      isComplete: boolean;
      lastDate: Date | null;
      lastRating: string | null;
    };

    const suraProgressMap = new Map<number, SuraProgress>();

    for (const rec of recitations) {
      const surahNums = this.surahNumsOf(rec);
      const isMulti = surahNums.length > 1;

      for (const surahNum of surahNums) {
        if (!suraProgressMap.has(surahNum)) {
          suraProgressMap.set(surahNum, {
            individualPages: 0,
            isComplete: false,
            lastDate: null,
            lastRating: null,
          });
        }

        const progress = suraProgressMap.get(surahNum)!;
        const sura = getSuraByNumber(surahNum);

        if (rec.rating === 'VERY_GOOD' || rec.rating === 'GOOD') {
          if (isMulti) {
            // Multi-select: every selected surah counts as fully memorized
            progress.individualPages += sura?.totalPages ?? 0;
            progress.isComplete = true;
          } else {
            // Single-surah: honor the pages the instructor entered
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
  // RECITATION HISTORY — joined surah names for multi-surah
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
  // LATEST HOMEWORK
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
  // INSTRUCTOR OVERVIEW — updated for multi-surah entries
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
          // Multi-select: each selected surah gets its full metadata pages
          for (const n of nums) {
            const sura = getSuraByNumber(n);
            const current = suraPages.get(n) || 0;
            suraPages.set(n, current + (sura?.totalPages || 0));
          }
        } else {
          // Single-surah: use pagesRecited (may be partial)
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

      const lastNums = lastRecitation
        ? this.surahNumsOf(lastRecitation)
        : [];
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
  // DELETE
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