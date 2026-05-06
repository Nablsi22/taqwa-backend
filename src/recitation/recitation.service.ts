import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateRecitationDto,
  CreateRecitationBatchDto,
  BulkMaqraaDto,
  RecitationRatingDto,
  BatchSegmentType,
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

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════

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

  /**
   * Compose a timestamp that carries the RECITATION's calendar date
   * (what the teacher selected) plus the CURRENT time-of-day (when
   * the record was actually entered).
   *
   * Why: when the instructor back-fills yesterday's recitation today,
   * the corresponding PointsLog row must display yesterday's date in
   * the student's points history — but two back-fills submitted right
   * now for the same past day should still sort by entry order.
   *
   * Parse YYYY-MM-DD manually (avoids `new Date("2025-04-10")` UTC
   * midnight shifting a day in negative-offset timezones).
   */
  private composePointsCreatedAt(dateStr: string): Date {
    const [y, m, d] = dateStr.split('-').map(Number);
    const now = new Date();
    return new Date(
      y,
      m - 1,
      d,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    );
  }

  /**
   * Resolve the PointCategory used for all recitation-sourced points.
   * Fallback chain kept identical to the prior inline logic to avoid
   * any behavior change for existing deployments.
   */
  private async findRecitationCategory() {
    return (
      (await this.prisma.pointCategory.findFirst({
        where: { name: { contains: 'Quran', mode: 'insensitive' } },
      })) ||
      (await this.prisma.pointCategory.findFirst({
        where: { name: { contains: 'recitation', mode: 'insensitive' } },
      })) ||
      (await this.prisma.pointCategory.findFirst({
        where: { name: { contains: 'Memorization', mode: 'insensitive' } },
      })) ||
      (await this.prisma.pointCategory.findFirst({
        where: { name: { contains: 'حفظ', mode: 'insensitive' } },
      })) ||
      (await this.prisma.pointCategory.findFirst())
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // CREATE — legacy single-recitation endpoint (UNCHANGED behavior)
  // ═══════════════════════════════════════════════════════════════════

  async create(dto: CreateRecitationDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) throw new NotFoundException('الطالب غير موجود');

    const pointsCreatedAt = this.composePointsCreatedAt(dto.date);

    const isNewFormat =
      dto.startSurah !== undefined && dto.startAya !== undefined;

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
          surahNumber: startSurah,
          surahNumbers: [startSurah],
          pagesRecited: Math.max(1, Math.round(pages)),
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
        pointsCreatedAt,
      );

      return {
        data: { ...recitation, suraNames: [surahMeta.nameAr] },
        suraName: surahMeta.nameAr,
        message: 'تم تسجيل التسميع بنجاح',
      };
    }

    // ── Legacy multi-surah path ──
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
      pointsCreatedAt,
    );

    const suraNames = dto.surahNumbers.map((n) => getSuraName(n));

    return {
      data: { ...recitation, suraNames },
      suraName: suraNames.join('، '),
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // CREATE BATCH — multi-segment session with PER-SEGMENT RATINGS
  //
  // Each segment carries its own rating and becomes its own Recitation
  // row. Each segment also generates its own PointsLog row, computed
  // from that segment's pages × multiplier(segment.rating) using the
  // EXISTING rating-multiplier rules (no formula change).
  //
  // Routing per segment type matches the single-recitation `create`
  // method exactly:
  //   AYA_RANGE → applyNewFormatPoints (decimal-precise)
  //   FULL_SURA → applyRecitationPoints (legacy per-rule)
  //
  // The DID_NOT_MEMORIZE placeholder path is preserved unchanged for
  // backward compatibility with existing Flutter clients.
  // ═══════════════════════════════════════════════════════════════════

  async createBatch(
    dto: CreateRecitationBatchDto,
    instructorId: string,
  ) {
    instructorId = await this.resolveInstructorId(instructorId);

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) throw new NotFoundException('الطالب غير موجود');

    const pointsCreatedAt = this.composePointsCreatedAt(dto.date);
    const recitationDate = new Date(dto.date);

    const isNoMemorize = dto.rating === RecitationRatingDto.DID_NOT_MEMORIZE;

    // ── DID_NOT_MEMORIZE: placeholder row, no segments, no points ──
    if (isNoMemorize) {
      const placeholder = await this.prisma.recitation.create({
        data: {
          studentId: dto.studentId,
          instructorId,
          surahNumber: 1,
          surahNumbers: [1],
          pagesRecited: 0,
          isCompleteSura: false,
          rating: dto.rating!,
          homework: dto.homework || null,
          date: recitationDate,
          startSurah: 1,
          startAya: 1,
          endSurah: 1,
          endAya: 1,
          pagesCalculated: new Prisma.Decimal(0),
        },
      });
      return {
        data: [placeholder],
        count: 1,
        totalPages: 0,
        message: 'تم تسجيل التسميع بنجاح',
      };
    }

    // ── Validate all segments up front — fail the entire batch early ──
    if (!Array.isArray(dto.segments) || dto.segments.length === 0) {
      throw new BadRequestException('يجب إضافة مقطع واحد على الأقل');
    }

    const validRatings = Object.values(RecitationRatingDto) as string[];

    for (const [idx, seg] of dto.segments.entries()) {
      const pos = idx + 1;
      if (!seg || typeof seg !== 'object') {
        throw new BadRequestException(`المقطع ${pos} غير صالح`);
      }

      // Per-segment rating — required on every segment.
      if (!seg.rating || !validRatings.includes(seg.rating as string)) {
        throw new BadRequestException(
          `المقطع ${pos}: التقييم غير صالح أو مفقود`,
        );
      }

      if (seg.type === BatchSegmentType.FULL_SURA) {
        if (!Array.isArray(seg.surahNumbers) || seg.surahNumbers.length === 0) {
          throw new BadRequestException(
            `المقطع ${pos}: يجب اختيار سورة واحدة على الأقل`,
          );
        }
        for (const n of seg.surahNumbers) {
          if (typeof n !== 'number' || !getSuraByNumber(n)) {
            throw new BadRequestException(
              `المقطع ${pos}: رقم السورة غير صالح: ${n}`,
            );
          }
        }
      } else if (seg.type === BatchSegmentType.AYA_RANGE) {
        const s = seg.startSurah;
        const sa = seg.startAya;
        const ea = seg.endAya;
        if (typeof s !== 'number' || typeof sa !== 'number' || typeof ea !== 'number') {
          throw new BadRequestException(
            `المقطع ${pos}: بيانات نطاق الآيات غير كاملة`,
          );
        }
        const v = validateRange(s, sa, s, ea);
        if (!v.valid) {
          throw new BadRequestException(`المقطع ${pos}: ${v.error}`);
        }
      } else {
        throw new BadRequestException(
          `المقطع ${pos}: نوع غير معروف (${seg.type})`,
        );
      }
    }

    // ── Transactional batch insert (per-segment ratings) ──
    type SegmentMeta = {
      recId: string;
      rating: string;
      pages: number;
      isAyaRange: boolean;
    };

    const { created, segmentMeta } = await this.prisma.$transaction(
      async (tx) => {
        const rows: any[] = [];
        const meta: SegmentMeta[] = [];

        for (const seg of dto.segments) {
          const segRating = seg.rating as string;

          if (seg.type === BatchSegmentType.FULL_SURA) {
            const nums: number[] = seg.surahNumbers!;
            const rawPages = nums.reduce(
              (sum, n) => sum + (getSuraByNumber(n)?.totalPages ?? 0),
              0,
            );
            const pages = Math.round(rawPages * 100) / 100;

            const rec = await tx.recitation.create({
              data: {
                studentId: dto.studentId,
                instructorId,
                surahNumber: nums[0],
                surahNumbers: nums,
                pagesRecited: pages,
                isCompleteSura: true,
                rating: segRating as any,
                homework: null, // attached to first row only, see below
                date: recitationDate,
              },
            });
            rows.push(rec);
            meta.push({
              recId: rec.id,
              rating: segRating,
              pages,
              isAyaRange: false,
            });
          } else {
            // AYA_RANGE
            const s: number = seg.startSurah!;
            const sa: number = seg.startAya!;
            const ea: number = seg.endAya!;
            const pages = calculatePages(s, sa, s, ea);
            const pagesDec = new Prisma.Decimal(pages.toFixed(3));
            const sMeta = getSurahMeta(s)!;

            const rec = await tx.recitation.create({
              data: {
                studentId: dto.studentId,
                instructorId,
                surahNumber: s,
                surahNumbers: [s],
                pagesRecited: Math.max(1, Math.round(pages)),
                isCompleteSura: sa === 1 && ea >= sMeta.numAyas,
                rating: segRating as any,
                homework: null,
                date: recitationDate,
                startSurah: s,
                startAya: sa,
                endSurah: s,
                endAya: ea,
                pagesCalculated: pagesDec,
              },
            });
            rows.push(rec);
            meta.push({
              recId: rec.id,
              rating: segRating,
              pages,
              isAyaRange: true,
            });
          }
        }

        // Homework is per-session — stamp it on the first row so the
        // "latest homework" query keeps working unchanged.
        if (dto.homework && rows.length > 0) {
          const updated = await tx.recitation.update({
            where: { id: rows[0].id },
            data: { homework: dto.homework },
          });
          rows[0] = updated;
        }

        return { created: rows, segmentMeta: meta };
      },
    );

    // ── Per-segment points (one PointsLog row per segment) ──
    // Routing matches single-recitation `create`: AYA_RANGE → decimal,
    // FULL_SURA → legacy per-rule. Both helpers are unchanged.
    for (const m of segmentMeta) {
      if (m.isAyaRange) {
        await this.applyNewFormatPoints(
          dto.studentId,
          instructorId,
          m.rating,
          m.pages,
          m.recId,
          pointsCreatedAt,
        );
      } else {
        await this.applyRecitationPoints(
          dto.studentId,
          instructorId,
          m.rating,
          m.pages,
          m.recId,
          pointsCreatedAt,
        );
      }
    }

    const totalPages = segmentMeta.reduce((s, m) => s + m.pages, 0);

    return {
      data: created,
      count: created.length,
      totalPages: Math.round(totalPages * 100) / 100,
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // BULK MAQRAA — unchanged
  // ═══════════════════════════════════════════════════════════════════

  async createBulkMaqraa(dto: BulkMaqraaDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const sura = getSuraByNumber(dto.surahNumber);
    if (!sura) {
      throw new BadRequestException(`رقم السورة غير صالح: ${dto.surahNumber}`);
    }

    const pointsCreatedAt = this.composePointsCreatedAt(dto.date);
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
        pointsCreatedAt,
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

  // ═══════════════════════════════════════════════════════════════════
  // POINTS — new format (decimal, exact)
  // ═══════════════════════════════════════════════════════════════════

  private async applyNewFormatPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pages: number,
    sourceId: string,
    createdAt: Date,
  ) {
    try {
      const amount = calculatePoints(pages, rating);
      if (!amount || amount <= 0) return;

      const category = await this.findRecitationCategory();
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
          createdAt,
        },
      });
    } catch (error) {
      console.error('Error applying new-format recitation points:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // POINTS — legacy per-rule path
  // ═══════════════════════════════════════════════════════════════════

  private async applyRecitationPoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pageCount: number,
    sourceId: string,
    createdAt: Date,
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
          const rulePoints = Number(maqraaRule.points);
          const pts = maqraaRule.isPerPage
            ? rulePoints * pageCount
            : rulePoints;
          pointResult = { points: pts, ruleNameAr: maqraaRule.nameAr };
        }
      } else {
        const raw = await this.pointRulesService.getRecitationPoints(
          rating,
          pageCount,
        );
        if (raw) {
          pointResult = {
            points: Number(raw.points),
            ruleNameAr: raw.ruleNameAr,
          };
        }
      }

      if (
        !pointResult ||
        pointResult.points === null ||
        pointResult.points === undefined ||
        isNaN(pointResult.points) ||
        pointResult.points === 0
      ) {
        console.warn(
          `[applyRecitationPoints] No points awarded — rating=${rating} pages=${pageCount} result=${JSON.stringify(pointResult)}`,
        );
        return;
      }

      const category = await this.findRecitationCategory();
      if (!category) {
        console.error('[applyRecitationPoints] No PointCategory found in DB');
        return;
      }

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
          createdAt,
        },
      });

      console.log(
        `[applyRecitationPoints] ✅ Awarded ${pointResult.points} pts to student ${studentId} for ${rating}`,
      );
    } catch (error) {
      console.error('[applyRecitationPoints] ❌ Error:', error);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // NEXT-AYA SUGGESTION
  // ═══════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════
  // STUDENT PROGRESS — unchanged
  // ═══════════════════════════════════════════════════════════════════

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
          if (isAyaRange && rec.startSurah === surahNum) {
            for (let a = rec.startAya!; a <= rec.endAya!; a++) {
              progress.ayaUnion.add(a);
            }
            const meta = getSurahMeta(surahNum);
            if (meta && progress.ayaUnion.size >= meta.numAyas) {
              progress.isComplete = true;
            }
          } else if (isMulti) {
            progress.individualPages += sura?.totalPages ?? 0;
            progress.isComplete = true;
          } else {
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

      const legacyPages = Math.min(
        progress?.individualPages || 0,
        sura.totalPages,
      );
      const legacyPct =
        sura.totalPages > 0 ? (legacyPages / sura.totalPages) * 100 : 0;

      const ayaCount = progress?.ayaUnion.size || 0;
      const ayaPct = numAyas > 0 ? (ayaCount / numAyas) * 100 : 0;
      const ayaPages = (ayaPct / 100) * sura.totalPages;

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

  // ═══════════════════════════════════════════════════════════════════
  // HISTORY / HOMEWORK / OVERVIEW / SURA LIST / DELETE — unchanged
  // ═══════════════════════════════════════════════════════════════════

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