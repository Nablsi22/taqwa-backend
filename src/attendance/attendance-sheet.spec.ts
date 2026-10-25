/* eslint-disable @typescript-eslint/no-unsafe-argument --
   Hand-rolled Prisma/terms doubles are untyped by design. */
import { AttendanceService } from './attendance.service';

// ═══════════════════════════════════════════════════════════════════════════
// GET /attendance/sheet — what the attendance screen needs to render a day:
// each student's status and excuse, the kind of day in the active course,
// and whether this server understands «غائب بعذر» at all.
// ═══════════════════════════════════════════════════════════════════════════

function build(
  opts: {
    activeTermId?: number | null;
    requiredDays?: number[];
    optionalDays?: number[];
  } = {},
) {
  const prisma: any = {
    student: {
      findMany: jest.fn().mockResolvedValue([
        { id: 's1', fullName: 'أحمد', instructorId: 'i1' },
        { id: 's2', fullName: 'بلال', instructorId: 'i1' },
        { id: 's3', fullName: 'خالد', instructorId: 'i1' },
      ]),
    },
    attendance: {
      findMany: jest.fn().mockResolvedValue([
        { studentId: 's1', status: 'PRESENT', excused: false, notes: null },
        { studentId: 's2', status: 'ABSENT', excused: true, notes: 'مريض' },
      ]),
    },
    term: {
      findUnique: jest.fn().mockResolvedValue({
        requiredDays: opts.requiredDays ?? [6],
        optionalDays: opts.optionalDays ?? [4],
      }),
    },
  };
  const terms: any = {
    getActiveTermId: jest
      .fn()
      .mockResolvedValue(
        opts.activeTermId === undefined ? 24 : opts.activeTermId,
      ),
  };
  return new AttendanceService(prisma, {} as any, terms);
}

describe('AttendanceService.getAttendanceSheet', () => {
  it('returns status, excuse and marked flag per student', async () => {
    const sheet = await build().getAttendanceSheet('2026-10-17', 'i1');
    expect(sheet.students).toEqual([
      {
        studentId: 's1',
        fullName: 'أحمد',
        status: 'PRESENT',
        excused: false,
        notes: null,
        isMarked: true,
      },
      {
        studentId: 's2',
        fullName: 'بلال',
        status: 'ABSENT',
        excused: true,
        notes: 'مريض',
        isMarked: true,
      },
      {
        studentId: 's3',
        fullName: 'خالد',
        status: null,
        excused: false,
        notes: null,
        isMarked: false,
      },
    ]);
    expect([
      sheet.totalStudents,
      sheet.markedCount,
      sheet.unmarkedCount,
    ]).toEqual([3, 2, 1]);
    expect(sheet.supportsExcused).toBe(true);
  });

  it('reports the kind of day in the active course', async () => {
    expect((await build().getAttendanceSheet('2026-10-17')).dayKind).toBe(
      'REQUIRED',
    ); // Saturday
    expect((await build().getAttendanceSheet('2026-10-15')).dayKind).toBe(
      'OPTIONAL',
    ); // Thursday
    expect((await build().getAttendanceSheet('2026-10-18')).dayKind).toBe(
      'EXTRA',
    ); // Sunday
  });

  it('treats every day as required for a course without meeting days, and null without a course', async () => {
    expect(
      (
        await build({ requiredDays: [], optionalDays: [] }).getAttendanceSheet(
          '2026-10-15',
        )
      ).dayKind,
    ).toBe('REQUIRED');
    expect(
      (await build({ activeTermId: null }).getAttendanceSheet('2026-10-17'))
        .dayKind,
    ).toBeNull();
  });
});
