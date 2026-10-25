/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument,
   @typescript-eslint/require-await --
   Hand-rolled Prisma/rules doubles: their inputs are untyped by design. */
import { BadRequestException } from '@nestjs/common';
import { AttendanceService } from './attendance.service';

// ═══════════════════════════════════════════════════════════════════════════
// Which attendance marks cost points.
//
//   REQUIRED day (winter Saturday)  PRESENT +5 · LATE −2 · ABSENT −5
//   OPTIONAL day (winter Thursday)  PRESENT +5 · LATE  0 · ABSENT  0
//   EXTRA day (outside schedule)    same as OPTIONAL
//   «غائب بعذر» on any day          0
//
// Prisma and the rules are stubbed; what is under test is the service's own
// decision about which points row exists after each mark or correction.
// ═══════════════════════════════════════════════════════════════════════════

const TERM_ID = 24;
const RULES = { PRESENT: 5, LATE: -2, ABSENT: -5 } as const;

function build(
  opts: { requiredDays?: number[]; optionalDays?: number[] } = {},
) {
  const attendance = new Map<string, any>(); // key studentId|date
  const points: any[] = [];

  const prisma: any = {
    term: {
      findUnique: jest.fn().mockResolvedValue({
        requiredDays: opts.requiredDays ?? [6],
        optionalDays: opts.optionalDays ?? [4],
      }),
    },
    pointCategory: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: where.type === 'EARN' ? 'cat-earn' : 'cat-deduct',
      })),
    },
    student: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'stu-1', fullName: 'طالب' }),
    },
    attendance: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = `${where.studentId_date.studentId}|${where.studentId_date.date.toISOString()}`;
        return attendance.get(k) ?? null;
      }),
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const k = `${where.studentId_date.studentId}|${where.studentId_date.date.toISOString()}`;
        const prev = attendance.get(k);
        const row = prev
          ? { ...prev, ...update }
          : { id: `att-${attendance.size + 1}`, ...create };
        attendance.set(k, row);
        return { ...row, student: { fullName: 'طالب' } };
      }),
    },
    pointsLog: {
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = points.length;
        for (let i = points.length - 1; i >= 0; i--) {
          if (
            points[i].sourceType === where.sourceType &&
            points[i].sourceId === where.sourceId
          )
            points.splice(i, 1);
        }
        return { count: before - points.length };
      }),
      create: jest.fn(async ({ data }: any) => {
        points.push(data);
        return data;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const pointRules: any = {
    getAttendancePoints: jest.fn(async (status: keyof typeof RULES) => ({
      points: RULES[status],
      ruleNameAr: status,
    })),
  };
  const terms: any = {
    requireActiveTermId: jest.fn().mockResolvedValue(TERM_ID),
  };
  const service = new AttendanceService(prisma, pointRules, terms);

  const mark = (
    date: string,
    status: 'PRESENT' | 'LATE' | 'ABSENT',
    excused?: boolean,
  ) =>
    service.markAttendance(
      {
        date,
        entries: [
          {
            studentId: '00000000-0000-4000-8000-000000000001',
            status: status as any,
            excused,
          },
        ],
      },
      'user-instructor',
    );
  const total = () => points.reduce((t, p) => t + Number(p.amount), 0);
  const row = () => [...attendance.values()][0];
  return { mark, points, total, row, prisma };
}

const SATURDAY = '2026-10-17';
const THURSDAY = '2026-10-15';
const SUNDAY = '2026-10-18';

describe('AttendanceService — points by day kind and excuse', () => {
  it('required day: the usual rules apply', async () => {
    for (const [status, expected] of [
      ['PRESENT', 5],
      ['LATE', -2],
      ['ABSENT', -5],
    ] as const) {
      const t = build();
      const res = await t.mark(SATURDAY, status);
      expect(res.dayKind).toBe('REQUIRED');
      expect(t.total()).toBe(expected);
      expect(t.points[0].termId).toBe(TERM_ID);
    }
  });

  it('optional Thursday: reward the present, deduct from nobody', async () => {
    for (const [status, expected] of [
      ['PRESENT', 5],
      ['LATE', 0],
      ['ABSENT', 0],
    ] as const) {
      const t = build();
      const res = await t.mark(THURSDAY, status);
      expect(res.dayKind).toBe('OPTIONAL');
      expect(t.total()).toBe(expected);
      expect(t.points.every((p) => Number(p.amount) >= 0)).toBe(true);
    }
  });

  it('a day outside the schedule is treated like an optional day', async () => {
    const t = build();
    const res = await t.mark(SUNDAY, 'ABSENT');
    expect(res.dayKind).toBe('EXTRA');
    expect(t.points).toHaveLength(0);
  });

  it('an excused absence on a required day costs nothing', async () => {
    const t = build();
    await t.mark(SATURDAY, 'ABSENT', true);
    expect(t.row().excused).toBe(true);
    expect(t.points).toHaveLength(0);
  });

  it('adding an excuse later removes the deduction; removing it restores it', async () => {
    const t = build();
    await t.mark(SATURDAY, 'ABSENT');
    expect(t.total()).toBe(-5);
    await t.mark(SATURDAY, 'ABSENT', true);
    expect(t.total()).toBe(0);
    expect(t.points).toHaveLength(0);
    await t.mark(SATURDAY, 'ABSENT', false);
    expect(t.total()).toBe(-5);
    expect(t.points).toHaveLength(1);
  });

  it('an older app re-saving the sheet without the field keeps the excuse', async () => {
    const t = build();
    await t.mark(SATURDAY, 'ABSENT', true);
    await t.mark(SATURDAY, 'ABSENT'); // excused omitted
    expect(t.row().excused).toBe(true);
    expect(t.points).toHaveLength(0);
  });

  it('changing an excused absence to present clears the excuse and awards points', async () => {
    const t = build();
    await t.mark(SATURDAY, 'ABSENT', true);
    await t.mark(SATURDAY, 'PRESENT');
    expect(t.row().excused).toBe(false);
    expect(t.total()).toBe(5);
    expect(t.points).toHaveLength(1);
  });

  it('re-saving an unchanged mark never duplicates points', async () => {
    const t = build();
    await t.mark(SATURDAY, 'PRESENT');
    await t.mark(SATURDAY, 'PRESENT');
    expect(t.points).toHaveLength(1);
  });

  it('rejects an excuse on anything but an absence, before writing anything', async () => {
    const t = build();
    await expect(t.mark(SATURDAY, 'PRESENT', true)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(t.prisma.attendance.upsert).not.toHaveBeenCalled();
    expect(t.points).toHaveLength(0);
  });

  it('a course with no configured meeting days keeps the old behaviour: every day can deduct', async () => {
    const t = build({ requiredDays: [], optionalDays: [] });
    const res = await t.mark(THURSDAY, 'ABSENT');
    expect(res.dayKind).toBe('REQUIRED');
    expect(t.total()).toBe(-5);
  });
});
