import { BadRequestException } from '@nestjs/common';
import { PointsService } from './points.service';
import { TermsService } from '../terms/terms.service';

// ═══════════════════════════════════════════════════════════════════════════
// "كل دورة مستقلة تماماً في النقاط والإحصائيات"
//
// The guarantees pinned here:
//   • a query for course B never sees course A's points
//   • a brand-new course reads 0 for every student, with no student and no
//     historical row deleted to achieve it
//   • nothing that produces points can be written without a course
// ═══════════════════════════════════════════════════════════════════════════

const WINTER = 1;
const SUMMER = 2;

/** Points as they might look after one full winter course. */
const ROWS = [
  { id: 'p1', studentId: 'a', termId: WINTER, amount: 40 },
  { id: 'p2', studentId: 'b', termId: WINTER, amount: 25 },
  { id: 'p3', studentId: 'c', termId: WINTER, amount: 25 },
  { id: 'p4', studentId: 'd', termId: WINTER, amount: 10 },
];

const STUDENTS = ['a', 'b', 'c', 'd'];

function buildPointsService(activeTermId: number | null) {
  const prisma: any = {
    student: {
      findMany: jest.fn(async ({ select }: any) =>
        STUDENTS.map((id) =>
          select?.fullName
            ? {
                id,
                fullName: `طالب ${id}`,
                instructorId: 'i1',
                instructor: { fullName: 'معلم' },
                pointsLog: [],
              }
            : { id },
        ),
      ),
    },
    pointsLog: {
      groupBy: jest.fn(async ({ where }: any) => {
        const termId = where?.termId;
        const ids: string[] = where?.studentId?.in ?? STUDENTS;
        const matching = ROWS.filter(
          (r) =>
            (termId === undefined || r.termId === termId) &&
            ids.includes(r.studentId),
        );
        const sums = new Map<string, number>();
        for (const r of matching) {
          sums.set(r.studentId, (sums.get(r.studentId) ?? 0) + r.amount);
        }
        return [...sums.entries()].map(([studentId, amount]) => ({
          studentId,
          _sum: { amount },
        }));
      }),
    },
  };

  const termsService: any = {
    getActiveTermId: jest.fn().mockResolvedValue(activeTermId),
  };

  return new PointsService(prisma, termsService);
}

describe('course isolation — points never cross a course boundary', () => {
  it('returns the winter totals when winter is being viewed', async () => {
    const service = buildPointsService(SUMMER);
    const { totals } = await service.getMosqueRanking(WINTER);
    expect(totals.get('a')).toBe(40);
    expect(totals.get('d')).toBe(10);
  });

  it('returns 0 for EVERY student in a course with no points yet', async () => {
    const service = buildPointsService(SUMMER);
    const { totals, total } = await service.getMosqueRanking(SUMMER);

    for (const id of STUDENTS) expect(totals.get(id)).toBe(0);
    // …and the students are all still there. A fresh course is not a purge.
    expect(total).toBe(STUDENTS.length);
    expect([...totals.keys()].sort()).toEqual(STUDENTS);
  });

  it('leaves the previous course untouched after the new one starts', async () => {
    const service = buildPointsService(SUMMER);
    await service.getMosqueRanking(SUMMER);
    const { totals } = await service.getMosqueRanking(WINTER);
    expect(totals.get('a')).toBe(40);
    expect(totals.get('b')).toBe(25);
  });

  it('defaults to the ACTIVE course when no course is named', async () => {
    const service = buildPointsService(WINTER);
    const { totals } = await service.getMosqueRanking();
    expect(totals.get('a')).toBe(40);
  });

  it('termId = 0 means "every course", for admin history views', async () => {
    const service = buildPointsService(SUMMER);
    const { totals } = await service.getMosqueRanking(0);
    // No term filter → the winter rows are visible again.
    expect(totals.get('a')).toBe(40);
  });

  it('ranks within one course only, ties sharing a position', async () => {
    const service = buildPointsService(SUMMER);
    const { ranks } = await service.getMosqueRanking(WINTER);
    expect(ranks.get('a')).toBe(1);
    expect(ranks.get('b')).toBe(2);
    expect(ranks.get('c')).toBe(2); // tie
    expect(ranks.get('d')).toBe(4); // standard competition ranking
  });

  it('gives every student rank 1 in an empty course — nobody is ahead yet', async () => {
    const service = buildPointsService(SUMMER);
    const { ranks } = await service.getMosqueRanking(SUMMER);
    for (const id of STUDENTS) expect(ranks.get(id)).toBe(1);
  });

  it('reports which course a rank was computed for', async () => {
    const service = buildPointsService(SUMMER);
    const result = await service.getStudentRank('a', WINTER);
    expect(result.termId).toBe(WINTER);
    expect(result.totalPoints).toBe(40);
  });
});

describe('TermsService.requireActiveTermId — no points without a course', () => {
  function build(activeTerm: { id: number } | null) {
    const prisma: any = {
      term: { findFirst: jest.fn().mockResolvedValue(activeTerm) },
    };
    return new TermsService(prisma);
  }

  it('returns the active course id', async () => {
    await expect(build({ id: SUMMER }).requireActiveTermId()).resolves.toBe(
      SUMMER,
    );
  });

  it('refuses with an actionable Arabic message when none is active', async () => {
    const service = build(null);
    await expect(service.requireActiveTermId()).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.requireActiveTermId()).rejects.toThrow(/إدارة الدورات/);
  });
});
