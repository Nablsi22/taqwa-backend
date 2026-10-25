import { BadRequestException } from '@nestjs/common';
import { RecitationService } from './recitation.service';
import {
  BatchSegmentType,
  RecitationRatingDto,
} from './dto/create-recitation.dto';

// ═══════════════════════════════════════════════════════════════════════════
// Course isolation + verse-range-only recording.
//
// Prisma, the rules table and the ranking service are stubbed: what is under
// test is the service's own decisions — which shape it accepts, which course
// it stamps a row with, and what it refuses.
// ═══════════════════════════════════════════════════════════════════════════

const ACTIVE_TERM_ID = 7;

function buildService(opts: { activeTermId?: number | null } = {}) {
  const activeTermId =
    opts.activeTermId === undefined ? ACTIVE_TERM_ID : opts.activeTermId;

  const created: any[] = [];
  const pointsRows: any[] = [];

  const prisma: any = {
    // resolveInstructorId falls back to the user id when no Instructor row
    // matches, which is the path these tests exercise.
    instructor: { findFirst: jest.fn().mockResolvedValue(null) },
    student: { findUnique: jest.fn().mockResolvedValue({ id: 'stu-1' }) },
    recitation: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `rec-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
    },
    pointsLog: {
      create: jest.fn(async ({ data }: any) => {
        pointsRows.push(data);
        return data;
      }),
    },
    pointCategory: {
      findFirst: jest.fn().mockResolvedValue({ id: 'cat-quran' }),
    },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    ),
  };

  const pointRulesService: any = {
    getRecitationPoints: jest
      .fn()
      .mockImplementation(async (rating: string, pages: number) =>
        rating === 'VERY_GOOD' || rating === 'GOOD'
          ? { points: pages * 2, ruleNameAr: 'حفظ' }
          : null,
      ),
    findByCode: jest.fn().mockResolvedValue(null),
  };

  const pointsService: any = { getMosqueRanking: jest.fn() };

  const termsService: any = {
    getActiveTermId: jest.fn().mockResolvedValue(activeTermId),
    requireActiveTermId: jest.fn(async () => {
      if (activeTermId == null) {
        throw new BadRequestException('لا توجد دورة مفعّلة حالياً');
      }
      return activeTermId;
    }),
  };

  const service = new RecitationService(
    prisma,
    pointRulesService,
    pointsService,
    termsService,
  );

  return { service, prisma, created, pointsRows, termsService };
}

const RANGE_SEGMENT = {
  type: BatchSegmentType.AYA_RANGE,
  rating: RecitationRatingDto.VERY_GOOD,
  startSurah: 78,
  startAya: 1,
  endAya: 10,
};

describe('RecitationService — «سورة كاملة» is retired', () => {
  it('refuses a FULL_SURA segment and names the segment position', async () => {
    const { service } = buildService();
    await expect(
      service.createBatch(
        {
          studentId: 'stu-1',
          date: '2026-09-10',
          segments: [
            RANGE_SEGMENT as any,
            {
              type: BatchSegmentType.FULL_SURA,
              rating: RecitationRatingDto.GOOD,
              surahNumbers: [78],
            } as any,
          ],
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow(/المقطع 2/);
  });

  it('tells the instructor to update the app rather than failing silently', async () => {
    const { service } = buildService();
    await expect(
      service.createBatch(
        {
          studentId: 'stu-1',
          date: '2026-09-10',
          segments: [
            {
              type: BatchSegmentType.FULL_SURA,
              rating: RecitationRatingDto.GOOD,
              surahNumbers: [78],
            } as any,
          ],
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow(/تحديث التطبيق/);
  });

  it('refuses the legacy whole-sura shape on POST /recitations', async () => {
    const { service } = buildService();
    await expect(
      service.create(
        {
          studentId: 'stu-1',
          surahNumbers: [78],
          pagesRecited: 2,
          rating: RecitationRatingDto.VERY_GOOD,
          date: '2026-09-10',
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('writes nothing at all when the shape is refused', async () => {
    const { service, prisma } = buildService();
    await expect(
      service.create(
        {
          studentId: 'stu-1',
          surahNumbers: [78],
          rating: RecitationRatingDto.GOOD,
          date: '2026-09-10',
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow();
    expect(prisma.recitation.create).not.toHaveBeenCalled();
    expect(prisma.pointsLog.create).not.toHaveBeenCalled();
  });
});

describe('RecitationService — verse range validation', () => {
  it('accepts a valid range and stores exactly what was recited', async () => {
    const { service, created } = buildService();
    const result: any = await service.create(
      {
        studentId: 'stu-1',
        startSurah: 78,
        startAya: 20,
        endAya: 30,
        rating: RecitationRatingDto.VERY_GOOD,
        date: '2026-09-10',
      } as any,
      'inst-1',
    );

    expect(created).toHaveLength(1);
    expect(created[0].startSurah).toBe(78);
    expect(created[0].startAya).toBe(20);
    expect(created[0].endSurah).toBe(78);
    expect(created[0].endAya).toBe(30);
    // 30 - 20 + 1
    expect(result.verseCount).toBe(11);
  });

  it('refuses an end ayah past the surah length', async () => {
    const { service } = buildService();
    await expect(
      service.create(
        {
          studentId: 'stu-1',
          startSurah: 67, // الملك, 30 ayat
          startAya: 1,
          endAya: 31,
          rating: RecitationRatingDto.GOOD,
          date: '2026-09-10',
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a reversed range', async () => {
    const { service } = buildService();
    await expect(
      service.create(
        {
          studentId: 'stu-1',
          startSurah: 78,
          startAya: 30,
          endAya: 10,
          rating: RecitationRatingDto.GOOD,
          date: '2026-09-10',
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('RecitationService — every row belongs to a course', () => {
  it('stamps the recitation AND its points with the active course', async () => {
    const { service, created, pointsRows } = buildService();
    await service.create(
      {
        studentId: 'stu-1',
        startSurah: 78,
        startAya: 1,
        endAya: 10,
        rating: RecitationRatingDto.VERY_GOOD,
        date: '2026-09-10',
      } as any,
      'inst-1',
    );

    expect(created[0].termId).toBe(ACTIVE_TERM_ID);
    expect(pointsRows).toHaveLength(1);
    expect(pointsRows[0].termId).toBe(ACTIVE_TERM_ID);
  });

  it('files a batch session and its points in one and the same course', async () => {
    const { service, created, pointsRows } = buildService();
    await service.createBatch(
      {
        studentId: 'stu-1',
        date: '2026-09-10',
        segments: [
          RANGE_SEGMENT as any,
          {
            type: BatchSegmentType.AYA_RANGE,
            rating: RecitationRatingDto.GOOD,
            startSurah: 67,
            startAya: 1,
            endAya: 15,
          } as any,
        ],
      } as any,
      'inst-1',
    );

    expect(created).toHaveLength(2);
    for (const row of created) expect(row.termId).toBe(ACTIVE_TERM_ID);
    for (const row of pointsRows) expect(row.termId).toBe(ACTIVE_TERM_ID);
  });

  it('refuses to record anything when no course is active', async () => {
    const { service, prisma } = buildService({ activeTermId: null });
    await expect(
      service.create(
        {
          studentId: 'stu-1',
          startSurah: 78,
          startAya: 1,
          endAya: 10,
          rating: RecitationRatingDto.VERY_GOOD,
          date: '2026-09-10',
        } as any,
        'inst-1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.recitation.create).not.toHaveBeenCalled();
  });
});

describe('RecitationService — المقرأة is a marker, not a score', () => {
  it('records the group without awarding a single point', async () => {
    const { service, created, pointsRows } = buildService();
    const result: any = await service.createBulkMaqraa(
      {
        studentIds: ['stu-1', 'stu-2', 'stu-3'],
        surahNumber: 67,
        date: '2026-09-10',
      } as any,
      'inst-1',
    );

    expect(created).toHaveLength(3);
    expect(pointsRows).toHaveLength(0);
    expect(result.pointsAwarded).toBe(0);
  });

  it('still files the marker under the active course', async () => {
    const { service, created } = buildService();
    await service.createBulkMaqraa(
      { studentIds: ['stu-1'], surahNumber: 67, date: '2026-09-10' } as any,
      'inst-1',
    );
    expect(created[0].termId).toBe(ACTIVE_TERM_ID);
  });

  it('rejects an empty group instead of recording nothing quietly', async () => {
    const { service } = buildService();
    await expect(
      service.createBulkMaqraa(
        { studentIds: [], surahNumber: 67, date: '2026-09-10' } as any,
        'inst-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
