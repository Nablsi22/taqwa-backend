import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
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
import { CreateHadithRecitationDto } from './dto/create-hadith-recitation.dto';
import { PointRulesService } from '../point-rules/point-rules.service';
import { PointsService } from '../points/points.service';
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
  getVerseCount,
} from '../quran-metadata/quran-ayat-pages.util';
import { TermsService } from '../terms/terms.service';

// ╔═══════════════════════════════════════════════════════════════════╗
// WHY THERE IS NO "WHOLE SURA" OPTION ANY MORE
//
// Until 2026-09 an instructor could record "سورة كاملة" and the page count
// came from a per-surah table, while an aya range was measured against the
// mushaf page map. The two disagreed badly — a production audit put whole-
// sura entries 40-75% above the exact figure for the same content, so two
// students who memorised the same ayat could receive very different points
// depending on which button their instructor pressed.
//
// Every recitation is now a verse range: surah + startAya + endAya. One
// measurement, one formula, identical for every student. Old clients that
// still send the whole-sura shape get FULL_SURA_RETIRED_MESSAGE, which tells
// the instructor to update the app rather than silently recording something
// unfair.
//
// Historical rows are untouched: they keep their original shape and their
// original points, and every read path below still renders them.
// ╚═══════════════════════════════════════════════════════════════════╝
const FULL_SURA_RETIRED_MESSAGE =
  'لم يعد تسجيل «سورة كاملة» متاحاً. يرجى تحديد السورة ثم «من آية» و«إلى آية». ' +
  'إذا لم تظهر لك هذه الخيارات فيرجى تحديث التطبيق إلى آخر إصدار.';

// ╔═══════════════════════════════════════════════════════════════════╗
// LAST-RECITATION DTO TYPES (Deliverable 2)
//
// Returned alongside (never instead of) existing fields. Every consumer
// that doesn't yet know about `lastRecitation` keeps working unchanged.
// ╚═══════════════════════════════════════════════════════════════════╝

export type SegmentKind = 'AYA_RANGE' | 'FULL_SURA' | 'MULTI_SURA';

export interface LastSegment {
  kind: SegmentKind;
  surahNumber: number;
  surahNameAr: string;
  fromAya: number | null;
  toAya: number | null;
  ayaCount: number;
  pages: number;
  rating: string;
}

export interface LastRecitation {
  recitedAt: Date;
  date: Date;
  overallRating: string | null;
  totalAyat: number;
  totalPages: number;
  segments: LastSegment[];
}

// Window used to group rows produced by a single `createBatch`
// transaction (or two consecutive `create` calls submitted as one
// session by the instructor). Spec: "within 1 minute".
const SESSION_WINDOW_SECONDS = 60;

// PointCategory "Nawawi 40 Hadith" — fixed id seeded on prod. Every hadith
// recitation's points_log row is filed under this exact category.
const HADITH_CATEGORY_ID = 'a0000000-0000-4000-8000-000000000040';

@Injectable()
export class RecitationService {
  constructor(
    private prisma: PrismaService,
    private pointRulesService: PointRulesService,
    private pointsService: PointsService,
    private termsService: TermsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // COURSE FILTER RESOLVER — identical semantics to PointsService:
  //   undefined → the active course (what an unmodified client gets)
  //   0         → every course (admin browsing full history)
  //   > 0       → that specific course
  // ═══════════════════════════════════════════════════════════════════
  private async resolveTermId(
    explicit?: number | null,
  ): Promise<number | null> {
    if (explicit === 0) return null;
    if (typeof explicit === 'number' && explicit > 0) return explicit;
    return this.termsService.getActiveTermId();
  }

  // ─────────────────────────────────────────────────────────────────
  // Helpers (unchanged)
  // ─────────────────────────────────────────────────────────────────

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

  // ╔═══════════════════════════════════════════════════════════════════╗
  // LAST-RECITATION BUILDER (Deliverable 2)
  //
  // For each studentId, returns the segments that belong to the latest
  // session — defined as the row with `MAX(created_at)` plus every other
  // row sharing the same calendar `date` and inserted within
  // SESSION_WINDOW_SECONDS of that anchor.
  //
  // Single round-trip: one $queryRaw using a CTE + DISTINCT ON. Postgres
  // resolves anchor + window in the database; we just shape the result.
  //
  // Refs:
  //   Prisma raw queries:            https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries
  //   Postgres DISTINCT ON:          https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT
  // ╚═══════════════════════════════════════════════════════════════════╝

  private async buildLastRecitationFor(
    studentIds: string[],
  ): Promise<Map<string, LastRecitation | null>> {
    const result = new Map<string, LastRecitation | null>();
    for (const id of studentIds) result.set(id, null);
    if (studentIds.length === 0) return result;

    type Row = {
      id: string;
      studentId: string;
      surahNumber: number;
      surahNumbers: number[] | null;
      pagesRecited: number;
      isCompleteSura: boolean;
      rating: string;
      homework: string | null;
      date: Date;
      createdAt: Date;
      startSurah: number | null;
      startAya: number | null;
      endSurah: number | null;
      endAya: number | null;
      pagesCalculated: Prisma.Decimal | string | number | null;
    };

    const sessionRows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH anchors AS (
        SELECT DISTINCT ON (student_id)
          student_id,
          created_at AS anchor_at,
          date       AS anchor_date
        FROM recitations
        WHERE student_id IN (${Prisma.join(studentIds)})
        ORDER BY student_id, created_at DESC
      )
      SELECT
        r.id                AS "id",
        r.student_id        AS "studentId",
        r.surah_number      AS "surahNumber",
        r.surah_numbers     AS "surahNumbers",
        r.pages_recited     AS "pagesRecited",
        r.is_complete_sura  AS "isCompleteSura",
        r.rating::text      AS "rating",
        r.homework          AS "homework",
        r.date              AS "date",
        r.created_at        AS "createdAt",
        r."startSurah"      AS "startSurah",
        r."startAya"        AS "startAya",
        r."endSurah"        AS "endSurah",
        r."endAya"          AS "endAya",
        r."pagesCalculated" AS "pagesCalculated"
      FROM recitations r
      INNER JOIN anchors a
        ON r.student_id = a.student_id
       AND r.date       = a.anchor_date
       AND r.created_at >= a.anchor_at - (${SESSION_WINDOW_SECONDS} * INTERVAL '1 second')
       AND r.created_at <= a.anchor_at
      ORDER BY r.student_id ASC, r.created_at ASC
    `);

    // Group rows by studentId
    const byStudent = new Map<string, Row[]>();
    for (const row of sessionRows) {
      const bucket = byStudent.get(row.studentId);
      if (bucket) bucket.push(row);
      else byStudent.set(row.studentId, [row]);
    }

    // Shape each session into the response DTO
    for (const [studentId, rows] of byStudent) {
      if (rows.length === 0) continue;
      const anchor = rows[rows.length - 1]; // ascending order → last is max(createdAt)

      const segments: LastSegment[] = rows.map((row) => {
        const surahNums =
          row.surahNumbers && row.surahNumbers.length > 0
            ? row.surahNumbers
            : [row.surahNumber];

        const isAyaRange =
          row.startAya != null &&
          row.endAya != null &&
          row.startSurah != null &&
          row.endSurah != null &&
          row.startSurah === row.endSurah;

        const isMultiSura = surahNums.length > 1;

        let kind: SegmentKind;
        let surahNumber: number;
        let surahNameAr: string;
        let fromAya: number | null = null;
        let toAya: number | null = null;
        let ayaCount = 0;
        let pages = 0;

        if (isAyaRange) {
          kind = 'AYA_RANGE';
          surahNumber = row.startSurah!;
          const meta = getSurahMeta(surahNumber);
          surahNameAr = meta?.nameAr ?? getSuraName(surahNumber);
          fromAya = row.startAya!;
          toAya = row.endAya!;
          ayaCount = toAya - fromAya + 1;
          pages =
            row.pagesCalculated != null
              ? Number(row.pagesCalculated)
              : Number(row.pagesRecited);
        } else if (isMultiSura) {
          kind = 'MULTI_SURA';
          surahNumber = surahNums[0];
          surahNameAr = surahNums.map((n) => getSuraName(n)).join('، ');
          ayaCount = surahNums.reduce(
            (s, n) => s + (getSurahMeta(n)?.numAyas ?? 0),
            0,
          );
          pages = Number(row.pagesRecited);
        } else {
          kind = 'FULL_SURA';
          surahNumber = surahNums[0];
          const meta = getSurahMeta(surahNumber);
          surahNameAr = meta?.nameAr ?? getSuraName(surahNumber);
          ayaCount = meta?.numAyas ?? 0;
          pages = Number(row.pagesRecited);
        }

        return {
          kind,
          surahNumber,
          surahNameAr,
          fromAya,
          toAya,
          ayaCount,
          pages: Math.round(pages * 1000) / 1000,
          rating: row.rating,
        };
      });

      const totalAyat = segments.reduce((s, seg) => s + seg.ayaCount, 0);
      const totalPages =
        Math.round(segments.reduce((s, seg) => s + seg.pages, 0) * 100) / 100;

      const ratingSet = new Set(segments.map((s) => s.rating));
      const overallRating =
        ratingSet.size === 1 ? segments[0].rating : null;

      result.set(studentId, {
        recitedAt: anchor.createdAt,
        date: anchor.date,
        overallRating,
        totalAyat,
        totalPages,
        segments,
      });
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  // CREATE — single recitation. VERSE RANGE ONLY.
  //
  // Exactly one accepted shape: startSurah + startAya + endAya, inside one
  // surah. The legacy whole-sura / multi-sura shape is refused with
  // FULL_SURA_RETIRED_MESSAGE (see the note at the top of this file).
  // ─────────────────────────────────────────────────────────────────

  async create(dto: CreateRecitationDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) throw new NotFoundException('الطالب غير موجود');

    // A recitation always belongs to exactly one course. Resolved here rather
    // than left to the set_term_id_to_active trigger so "no active course"
    // surfaces as an actionable Arabic message instead of a constraint error.
    const termId = await this.termsService.requireActiveTermId();

    if (dto.startSurah === undefined || dto.startAya === undefined) {
      throw new BadRequestException(FULL_SURA_RETIRED_MESSAGE);
    }

    const startSurah = dto.startSurah;
    const endSurah = dto.endSurah ?? startSurah;
    const startAya = dto.startAya;
    const endAya = dto.endAya ?? startAya;

    const v = validateRange(startSurah, startAya, endSurah, endAya);
    if (!v.valid) throw new BadRequestException(v.error);

    const verseCount = getVerseCount(startAya, endAya);
    const pages = calculatePages(startSurah, startAya, endSurah, endAya);
    const pagesDec = new Prisma.Decimal(pages.toFixed(3));
    const surahMeta = getSurahMeta(startSurah)!;
    const pointsCreatedAt = this.composePointsCreatedAt(dto.date);

    const recitation = await this.prisma.recitation.create({
      data: {
        studentId: dto.studentId,
        instructorId,
        surahNumber: startSurah,
        surahNumbers: [startSurah],
        // Legacy display column, kept in step with the range for any older
        // screen still reading it. `pagesCalculated` holds the exact figure
        // and is the only one the points formula ever sees.
        pagesRecited: Math.max(1, Math.round(pages)),
        isCompleteSura: startAya === 1 && endAya >= surahMeta.numAyas,
        rating: dto.rating,
        homework: dto.homework || null,
        date: new Date(dto.date),
        termId,
        startSurah,
        startAya,
        endSurah: startSurah,
        endAya,
        pagesCalculated: pagesDec,
      },
    });

    await this.applyRangePoints(
      dto.studentId,
      instructorId,
      dto.rating,
      pages,
      recitation.id,
      pointsCreatedAt,
      termId,
    );

    return {
      data: { ...recitation, suraNames: [surahMeta.nameAr], verseCount },
      suraName: surahMeta.nameAr,
      verseCount,
      pages: Math.round(pages * 1000) / 1000,
      termId,
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // CREATE BATCH — multi-segment session. VERSE RANGE ONLY.
  //
  // Every segment is surah + startAya + endAya. A FULL_SURA segment from an
  // older client is refused with FULL_SURA_RETIRED_MESSAGE, naming the
  // segment position so the instructor knows which row to fix.
  // ─────────────────────────────────────────────────────────────────

  async createBatch(
    dto: CreateRecitationBatchDto,
    instructorId: string,
  ) {
    instructorId = await this.resolveInstructorId(instructorId);

    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student) throw new NotFoundException('الطالب غير موجود');

    const termId = await this.termsService.requireActiveTermId();
    const pointsCreatedAt = this.composePointsCreatedAt(dto.date);
    const recitationDate = new Date(dto.date);

    const isNoMemorize = dto.rating === RecitationRatingDto.DID_NOT_MEMORIZE;

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
          termId,
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

    if (!Array.isArray(dto.segments) || dto.segments.length === 0) {
      throw new BadRequestException('يجب إضافة مقطع واحد على الأقل');
    }

    const validRatings = Object.values(RecitationRatingDto) as string[];

    for (const [idx, seg] of dto.segments.entries()) {
      const pos = idx + 1;
      if (!seg || typeof seg !== 'object') {
        throw new BadRequestException(`المقطع ${pos} غير صالح`);
      }

      if (!seg.rating || !validRatings.includes(seg.rating as string)) {
        throw new BadRequestException(
          `المقطع ${pos}: التقييم غير صالح أو مفقود`,
        );
      }

      if (seg.type === BatchSegmentType.FULL_SURA) {
        throw new BadRequestException(
          `المقطع ${pos}: ${FULL_SURA_RETIRED_MESSAGE}`,
        );
      }
      if (seg.type !== BatchSegmentType.AYA_RANGE) {
        throw new BadRequestException(
          `المقطع ${pos}: نوع غير معروف (${seg.type})`,
        );
      }

      const s = seg.startSurah;
      const sa = seg.startAya;
      const ea = seg.endAya;
      if (
        typeof s !== 'number' ||
        typeof sa !== 'number' ||
        typeof ea !== 'number'
      ) {
        throw new BadRequestException(
          `المقطع ${pos}: يجب تحديد السورة و«من آية» و«إلى آية»`,
        );
      }
      if (!getSuraByNumber(s)) {
        throw new BadRequestException(`المقطع ${pos}: رقم السورة غير صالح: ${s}`);
      }
      const v = validateRange(s, sa, s, ea);
      if (!v.valid) {
        throw new BadRequestException(`المقطع ${pos}: ${v.error}`);
      }
    }

    type SegmentMeta = {
      recId: string;
      rating: string;
      pages: number;
      verseCount: number;
    };

    const { created, segmentMeta } = await this.prisma.$transaction(
      async (tx) => {
        const rows: any[] = [];
        const meta: SegmentMeta[] = [];

        for (const seg of dto.segments) {
          const segRating = seg.rating as string;
          const s: number = seg.startSurah!;
          const sa: number = seg.startAya!;
          const ea: number = seg.endAya!;

          // One measurement for every segment: the exact mushaf page span of
          // the ayat actually recited. Nothing here depends on which surah it
          // is or on whether the range happens to cover the whole surah.
          const pages = calculatePages(s, sa, s, ea);
          const verseCount = getVerseCount(sa, ea);
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
              termId,
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
            verseCount,
          });
        }

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

    for (const m of segmentMeta) {
      await this.applyRangePoints(
        dto.studentId,
        instructorId,
        m.rating,
        m.pages,
        m.recId,
        pointsCreatedAt,
        termId,
      );
    }

    const totalPages = segmentMeta.reduce((s, m) => s + m.pages, 0);
    const totalVerses = segmentMeta.reduce((s, m) => s + m.verseCount, 0);

    return {
      data: created,
      count: created.length,
      totalPages: Math.round(totalPages * 100) / 100,
      totalVerses,
      termId,
      message: 'تم تسجيل التسميع بنجاح',
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // BULK MAQRAA — a marker, not a score.
  //
  // A مقرأة is group reading with the instructor. It tells parents that a
  // session happened today; it is not memorisation and it awards NO points,
  // neither positive nor negative. It therefore also carries no verse range,
  // which is why `recitations_verse_range_chk` exempts rating = 'MAQRAA'.
  //
  // Historical MAQRAA points rows are left exactly as they are — this only
  // changes what happens from now on.
  // ─────────────────────────────────────────────────────────────────

  async createBulkMaqraa(dto: BulkMaqraaDto, instructorId: string) {
    instructorId = await this.resolveInstructorId(instructorId);

    const sura = getSuraByNumber(dto.surahNumber);
    if (!sura) {
      throw new BadRequestException(`رقم السورة غير صالح: ${dto.surahNumber}`);
    }
    if (!Array.isArray(dto.studentIds) || dto.studentIds.length === 0) {
      throw new BadRequestException('يجب اختيار طالب واحد على الأقل');
    }

    const termId = await this.termsService.requireActiveTermId();
    const recitationDate = new Date(dto.date);

    // One transaction: either the whole group is marked or none of it is, so
    // a mid-loop failure can never leave half a حلقة recorded.
    const results = await this.prisma.$transaction(
      dto.studentIds.map((studentId) =>
        this.prisma.recitation.create({
          data: {
            studentId,
            instructorId,
            surahNumber: dto.surahNumber,
            surahNumbers: [dto.surahNumber],
            pagesRecited: dto.pagesRecited || 0,
            isCompleteSura: false,
            rating: 'MAQRAA',
            date: recitationDate,
            termId,
          },
        }),
      ),
    );

    return {
      data: results,
      count: results.length,
      suraName: sura.nameAr,
      pointsAwarded: 0,
      termId,
      message: `تم تسجيل المقرأة لـ ${results.length} طالب`,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // POINTS — new format (UNCHANGED)
  // ─────────────────────────────────────────────────────────────────


  // ---------------------------------------------------------------
  // POINTS - unified recitation description (presentational only).
  //
  // Both write paths emit an identical label that always carries the
  // page count, so two students with different page totals can never
  // display the same text. No point value is computed or altered
  // here, and no existing points_log row is ever rewritten.
  // ---------------------------------------------------------------

  private static readonly RATING_AR: Readonly<Record<string, string>> = {
    VERY_GOOD: 'جيد جداً',
    GOOD: 'جيد',
    REPEAT: 'إعادة',
    DID_NOT_MEMORIZE: 'لم يحفظ',
    MAQRAA: 'مقرأة',
  };

  /** Always renders the page count, e.g. 1.94 -> "... 1.94 ... - ...". */
  private buildRecitationDescription(pages: number, rating: string): string {
    const ratingAr = RecitationService.RATING_AR[rating] ?? rating;
    const safePages = Number.isFinite(pages) && pages > 0 ? pages : 0;
    return `تسميع ${safePages.toFixed(2)} صفحة — ${ratingAr}`;
  }

  /**
   * The single write path for recitation points.
   *
   * Input is always a page span measured from a verse range, so two students
   * who recited the same ayat receive byte-for-byte the same amount. Per-page
   * rates come from the admin-editable `point_rules` table so an edit on the
   * rules screen applies everywhere; calculatePoints() remains only as a
   * fallback when no matching active rule exists, which preserves the
   * previous behaviour instead of silently awarding nothing.
   *
   * `termId` is passed in rather than left to the DB trigger: the points row
   * must land in the same course as the recitation that produced it, even if
   * an admin activates a different course mid-request.
   */
  private async applyRangePoints(
    studentId: string,
    instructorId: string,
    rating: string,
    pages: number,
    sourceId: string,
    createdAt: Date,
    termId: number,
  ) {
    try {
      const ruleResult = await this.pointRulesService.getRecitationPoints(
        rating,
        pages,
      );
      const ruleAmount = ruleResult ? Number(ruleResult.points) : NaN;
      const amount = Number.isFinite(ruleAmount)
        ? ruleAmount
        : calculatePoints(pages, rating);
      if (!amount || amount <= 0) return;

      const category = await this.findRecitationCategory();
      if (!category) {
        console.error('[applyRangePoints] No PointCategory found in DB');
        return;
      }

      await this.prisma.pointsLog.create({
        data: {
          studentId,
          categoryId: category.id,
          amount: new Prisma.Decimal(amount.toFixed(3)),
          rating: rating as any,
          description: this.buildRecitationDescription(pages, rating),
          awardedBy: instructorId,
          sourceId,
          sourceType: 'RECITATION',
          termId,
          createdAt,
        },
      });
    } catch (error) {
      console.error('[applyRangePoints] Error applying recitation points:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // NEXT-AYA SUGGESTION
  //
  // Deliberately NOT course-scoped: memorisation carries across courses, so
  // a student who finished الملك last term continues from where they left
  // off, not from الفاتحة. Only points restart with a new course.
  // ─────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────
  // STUDENT PROGRESS (UNCHANGED)
  // ─────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────
  // STUDENT RECITATION HISTORY  ◄── EXTENDED for D2
  //
  // Adds top-level `lastRecitation` field. Existing `data` array shape
  // is unchanged so any current consumer (e.g. Flutter `getStudentHistory`
  // which reads `response.data['data']`) keeps working untouched.
  // ─────────────────────────────────────────────────────────────────

  // Ayah count for one recitation row. An explicit single-sura range is
  // authoritative; otherwise the row stands for whole suras and the
  // count is their combined length.
  private ayaCountOf(rec: {
    startAya: number | null;
    endAya: number | null;
    startSurah: number | null;
    endSurah: number | null;
    surahNumbers: number[] | null;
    surahNumber: number;
  }): number {
    if (
      rec.startAya != null &&
      rec.endAya != null &&
      rec.startSurah != null &&
      rec.endSurah != null &&
      rec.startSurah === rec.endSurah
    ) {
      return Math.max(0, rec.endAya - rec.startAya + 1);
    }
    return this.surahNumsOf(rec).reduce(
      (sum, n) => sum + (getSurahMeta(n)?.numAyas ?? 0),
      0,
    );
  }

  async getStudentRecitations(
    studentId: string,
    params?: { termId?: number | null },
  ) {
    // Course-scoped like every other points-facing read: `?termId=0` returns
    // the full history, a specific id returns that course, absent returns the
    // active one.
    const resolvedTermId = await this.resolveTermId(params?.termId);
    const termWhere = resolvedTermId == null ? {} : { termId: resolvedTermId };

    const [recitations, lastMap] = await Promise.all([
      this.prisma.recitation.findMany({
        where: { studentId, ...termWhere },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      }),
      this.buildLastRecitationFor([studentId]),
    ]);

    // What the student actually received, read from the log rather than
    // recomputed. A third implementation of the points rules here would
    // be a third thing to keep in step.
    const recIds = recitations.map((r) => r.id);
    const pointsByRecitation = new Map<string, number>();
    if (recIds.length > 0) {
      const grouped = await this.prisma.pointsLog.groupBy({
        by: ['sourceId'],
        where: {
          sourceType: 'RECITATION',
          sourceId: { in: recIds },
        },
        _sum: { amount: true },
      });
      for (const g of grouped) {
        if (g.sourceId) {
          pointsByRecitation.set(g.sourceId, Number(g._sum.amount ?? 0));
        }
      }
    }

    const data = recitations.map((rec) => {
      const surahNums = this.surahNumsOf(rec);
      const suraNames = surahNums.map((n) => getSuraName(n));
      return {
        ...rec,
        surahNumbers: surahNums,
        suraName: suraNames.join('، '),
        suraNames,
        pointsAwarded: pointsByRecitation.get(rec.id) ?? 0,
        ayaCount: this.ayaCountOf(rec),
      };
    });

    // Nawawi entries so the client can lay Quran and hadith on one
    // timeline. hadith_recitations has no calendar date column, only
    // createdAt, so these group by the day they were recorded.
    const hadithRows = await this.prisma.hadithRecitation.findMany({
      where: { studentId, ...termWhere },
      orderBy: { createdAt: 'desc' },
    });

    const hadithTitles = new Map<number, string | null>();
    if (hadithRows.length > 0) {
      const rules = await this.prisma.hadithPointsRule.findMany({
        where: {
          hadithNumber: { in: hadithRows.map((h) => h.hadithNumber) },
        },
        select: { hadithNumber: true, title: true },
      });
      for (const r of rules) {
        hadithTitles.set(r.hadithNumber, r.title);
      }
    }

    const hadithEntries = hadithRows.map((h) => ({
      id: h.id,
      hadithNumber: h.hadithNumber,
      title: hadithTitles.get(h.hadithNumber) ?? null,
      pointsAwarded: h.pointsAwarded,
      createdAt: h.createdAt,
    }));

    return {
      data,
      hadithEntries,
      termId: resolvedTermId,
      lastRecitation: lastMap.get(studentId) ?? null,
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

  // ─────────────────────────────────────────────────────────────────
  // INSTRUCTOR OVERVIEW  ◄── EXTENDED for D2
  //
  // Adds `lastRecitation` per-student. All previously-returned fields
  // stay byte-for-byte the same. The existing per-student aggregation
  // loop is left untouched.
  // ─────────────────────────────────────────────────────────────────

  // ---------------------------------------------------------------
  // ROSTER METRICS
  //
  // Points balance, mosque-wide rank and last attendance for one
  // instructor roster, in three grouped queries rather than three per
  // student. Returns maps so the caller can attach values without a
  // second pass over the data.
  //
  // Only the rank NUMBER crosses the wire. Computing it here rather
  // than shipping the leaderboard to the device keeps every other
  // student name and total on the server.
  // ---------------------------------------------------------------
  private async buildRosterMetrics(
    studentIds: string[],
    termId?: number | null,
  ): Promise<{
    points: Map<string, number>;
    rank: Map<string, number>;
    lastAttendance: Map<string, Date | null>;
    total: number;
  }> {
    const points = new Map<string, number>();
    const rank = new Map<string, number>();
    const lastAttendance = new Map<string, Date | null>();
    let mosqueTotal = 0;

    for (const id of studentIds) {
      points.set(id, 0);
      lastAttendance.set(id, null);
    }
    if (studentIds.length === 0) {
      return { points, rank, lastAttendance, total: 0 };
    }

    // Ranking is delegated to PointsService, which owns the single
    // implementation. A local copy here would drift from the leaderboard
    // and from the detail screen the moment either changed.
    const ranking = await this.pointsService.getMosqueRanking(termId);
    mosqueTotal = ranking.total;
    for (const id of studentIds) {
      points.set(id, ranking.totals.get(id) ?? 0);
      const r = ranking.ranks.get(id);
      if (r != null) rank.set(id, r);
    }

    // Not term-filtered on purpose: the attendance table has no term
    // column, and "last attendance" is a historical fact.
    const attendanceRows = await this.prisma.attendance.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds } },
      _max: { date: true },
    });
    for (const row of attendanceRows) {
      lastAttendance.set(row.studentId, row._max.date ?? null);
    }

    return { points, rank, lastAttendance, total: mosqueTotal };
  }

  async getInstructorOverview(
    instructorId: string,
    params?: { termId?: number | null },
  ) {
    instructorId = await this.resolveInstructorId(instructorId);
    const resolvedTermId = await this.resolveTermId(params?.termId);

    const students = await this.prisma.student.findMany({
      where: { instructorId, deletedAt: null },
      include: { user: true },
    });

    // One round-trip for ALL last-recitations across the instructor's
    // entire roster. Avoids introducing per-student N+1 in the new code.
    const lastMap = await this.buildLastRecitationFor(
      students.map((s) => s.id),
    );

    const metrics = await this.buildRosterMetrics(
      students.map((s) => s.id),
      resolvedTermId,
    );

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
        // ◄── NEW (D2): full last-session detail. Older clients ignore it.
        lastRecitation: lastMap.get(student.id) ?? null,
        // Additive roster metrics. Older clients ignore unknown keys.
        pointsBalance: metrics.points.get(student.id) ?? 0,
        mosqueRank: metrics.rank.get(student.id) ?? null,
        mosqueTotal: metrics.total,
        lastAttendanceDate: metrics.lastAttendance.get(student.id) ?? null,
      });
    }

    return { data: overview, termId: resolvedTermId };
  }

  /**
   * Surah list for the recitation form. `numAyas` is included so the picker
   * can show each surah's real ayah count and cap the "إلى آية" stepper at it
   * — the same ceiling validateRange() enforces on the way in.
   */
  getSuraList() {
    return {
      data: SURA_METADATA.map((s) => ({
        number: s.number,
        nameAr: s.nameAr,
        totalPages: s.totalPages,
        juz: s.juzStart,
        numAyas: getSurahMeta(s.number)?.numAyas ?? 0,
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

  // ─────────────────────────────────────────────────────────────────
  // NAWAWI 40 HADITH — record one recitation (mirrors the Quran write
  // pattern: resolve instructor → verify student → snapshot points →
  // insert recitation + points_log atomically).
  //
  // English exceptions by design (backend messages for this feature are
  // English). Both inserts live in ONE $transaction so a failure on
  // either rolls back both: never points without a recitation row, nor a
  // recitation row without points.
  // ─────────────────────────────────────────────────────────────────

  async recordHadithRecitation(
    dto: CreateHadithRecitationDto,
    instructorId: string,
  ) {
    instructorId = await this.resolveInstructorId(instructorId);
    const termId = await this.termsService.requireActiveTermId();
    // «تاريخ التسجيل»: hadith_recitations has no date column, so the chosen
    // day is carried by created_at on BOTH rows (recitation + points), which
    // is what every history screen groups by. undefined = now.
    const createdAt = await this.termsService.resolveRecordTimestamp(dto.date);

    try {
      const recitation = await this.prisma.$transaction(async (tx) => {
        // Verify the student exists.
        const student = await tx.student.findUnique({
          where: { id: dto.studentId },
        });
        if (!student) throw new NotFoundException('Student not found');

        // Snapshot base_points from the rule — the awarded amount is frozen
        // on the recitation row, independent of future rule edits.
        const rule = await tx.hadithPointsRule.findUnique({
          where: { hadithNumber: dto.hadithNumber },
        });
        if (!rule) throw new NotFoundException('Hadith rule not found');

        const basePoints = rule.basePoints;

        // 1) hadith_recitations — the course is resolved in the application
        //    layer (see applyRangePoints) so the recitation row and its
        //    points row can never land in two different courses.
        const created = await tx.hadithRecitation.create({
          data: {
            studentId: dto.studentId,
            instructorId,
            hadithNumber: dto.hadithNumber,
            pointsAwarded: basePoints,
            termId,
            ...(createdAt && { createdAt }),
          },
        });

        // 2) points_log — same transaction, sourceId points back at the new
        //    recitation row (mirrors Quran's RECITATION sourceType).
        await tx.pointsLog.create({
          data: {
            studentId: dto.studentId,
            categoryId: HADITH_CATEGORY_ID,
            amount: new Prisma.Decimal(basePoints),
            awardedBy: instructorId,
            sourceId: created.id,
            sourceType: 'HADITH_RECITATION',
            termId,
            ...(createdAt && { createdAt }),
          },
        });

        return created;
      });

      return {
        data: recitation,
        pointsAwarded: recitation.pointsAwarded,
        message: 'Hadith recitation recorded successfully',
      };
    } catch (error) {
      // UNIQUE(student_id, hadith_number) violation → already recorded.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Hadith already recorded for this student.',
        );
      }
      throw error;
    }
  }

  // All 42 Nawawi rules, ordered by hadith number (1 → 42).
  async getHadithRules() {
    const data = await this.prisma.hadithPointsRule.findMany({
      orderBy: { hadithNumber: 'asc' },
    });
    return { data };
  }

  // ─────────────────────────────────────────────────────────────────
  // NAWAWI 40 HADITH — memorization map for one student.
  //
  // Returns which of the 42 ahadith the student has already recorded,
  // CUMULATIVE across all terms: a memorized hadith stays memorized,
  // so this is deliberately NOT filtered by activeTermId (unlike the
  // points-facing endpoints). Backed by UNIQUE(student_id,
  // hadith_number), so each number appears at most once.
  //
  // Read-only and additive — no existing query or formula is touched.
  // ─────────────────────────────────────────────────────────────────
  async getStudentHadithProgress(studentId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('Student not found');

    const rows = await this.prisma.hadithRecitation.findMany({
      where: { studentId },
      select: {
        hadithNumber: true,
        pointsAwarded: true,
        createdAt: true,
      },
      orderBy: { hadithNumber: 'asc' },
    });

    return {
      data: {
        memorized: rows.map((r) => r.hadithNumber),
        details: rows,
        count: rows.length,
        total: 42,
      },
    };
  }
}