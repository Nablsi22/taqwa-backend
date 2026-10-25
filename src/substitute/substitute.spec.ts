/* eslint-disable @typescript-eslint/no-unsafe-argument --
   Hand-rolled Prisma doubles are untyped by design. */
import { SubstituteService } from './substitute.service';

// ═══════════════════════════════════════════════════════════════════════════
// «حلقات أخرى» — the picker, the names-only roster and «استلمت هالحلقة اليوم».
//
// The rules being protected here are the mosque's:
//   • a substitute is offered every حلقة except his own and «عزل»;
//   • he sees names, and how much of the day is already recorded;
//   • claiming a حلقة is a note about one day, idempotent, and never moves
//     a student;
//   • an instructor only ever sees his own claims; an admin sees all.
// ═══════════════════════════════════════════════════════════════════════════

const HALAQAS = [
  {
    id: 'i1',
    fullName: 'أ. أحمد',
    isHoldingPool: false,
    students: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
  },
  {
    id: 'i2',
    fullName: 'أ. بلال',
    isHoldingPool: false,
    students: [{ id: 's4' }, { id: 's5' }],
  },
];

function build(
  opts: {
    /** The instructor row behind the caller's user id. null → none. */
    own?: { id: string } | null;
    halaqas?: any[];
    /** Attendance rows that exist on the day. */
    records?: { studentId: string }[];
    coverage?: any[];
    requiredDays?: number[];
    optionalDays?: number[];
    activeTerm?: { requiredDays: number[]; optionalDays: number[] } | null;
    students?: any[];
    coverageFirst?: any;
  } = {},
) {
  const term =
    opts.activeTerm === undefined
      ? {
          requiredDays: opts.requiredDays ?? [6],
          optionalDays: opts.optionalDays ?? [4],
        }
      : opts.activeTerm;

  const prisma: any = {
    instructor: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.userId !== undefined) {
          return Promise.resolve(
            opts.own === undefined ? { id: 'me' } : opts.own,
          );
        }
        const found = (opts.halaqas ?? HALAQAS).find(
          (h: any) => h.id === where.id,
        );
        return Promise.resolve(found ?? null);
      }),
      findMany: jest.fn().mockResolvedValue(opts.halaqas ?? HALAQAS),
    },
    student: {
      findMany: jest.fn().mockResolvedValue(
        opts.students ?? [
          { id: 's1', fullName: 'أحمد', fatherName: 'محمد' },
          { id: 's2', fullName: 'بلال', fatherName: 'سامر' },
        ],
      ),
    },
    attendance: {
      findMany: jest.fn().mockResolvedValue(opts.records ?? []),
    },
    halaqaCoverage: {
      findMany: jest.fn().mockResolvedValue(opts.coverage ?? []),
      findFirst: jest.fn().mockResolvedValue(opts.coverageFirst ?? null),
      upsert: jest.fn(({ create }: any) =>
        Promise.resolve({
          ...create,
          halaqaInstructor: { fullName: 'أ. أحمد' },
          coveringInstructor: { fullName: 'أ. بلال' },
        }),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    term: {
      findUnique: jest.fn().mockResolvedValue(term),
      findFirst: jest.fn().mockResolvedValue(term),
    },
  };
  return { service: new SubstituteService(prisma), prisma };
}

const INSTRUCTOR = { userId: 'u-me', role: 'INSTRUCTOR' };
const ADMIN = { userId: 'u-admin', role: 'ADMIN' };

describe('SubstituteService.otherHalaqas', () => {
  it('leaves out the viewer own حلقة and «عزل», and only حلقات with students', async () => {
    const { service, prisma } = build({ own: { id: 'i9' } });
    await service.otherHalaqas(INSTRUCTOR, '2026-10-17');
    expect(prisma.instructor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isHoldingPool: false,
          id: { not: 'i9' },
          students: { some: { deletedAt: null } },
        },
      }),
    );
  });

  it('counts what is already recorded per حلقة, not across حلقات', async () => {
    const { service } = build({
      own: { id: 'i9' },
      // Two of أ. أحمد's three, one of أ. بلال's two.
      records: [{ studentId: 's1' }, { studentId: 's2' }, { studentId: 's4' }],
    });
    const res = await service.otherHalaqas(INSTRUCTOR, '2026-10-17');
    expect(res.halaqas).toEqual([
      expect.objectContaining({
        instructorId: 'i1',
        students: 3,
        recorded: 2,
        unmarked: 1,
        notRecorded: false,
      }),
      expect.objectContaining({
        instructorId: 'i2',
        students: 2,
        recorded: 1,
        unmarked: 1,
        notRecorded: false,
      }),
    ]);
  });

  it('flags a حلقة nobody recorded', async () => {
    const { service } = build({ own: { id: 'i9' }, records: [] });
    const res = await service.otherHalaqas(INSTRUCTOR, '2026-10-17');
    expect(res.halaqas.map((h) => h.notRecorded)).toEqual([true, true]);
    expect(res.halaqas.map((h) => h.unmarked)).toEqual([3, 2]);
  });

  it('names every substitute who claimed a حلقة, and marks the viewer own claim', async () => {
    const { service } = build({
      own: { id: 'i9' },
      coverage: [
        {
          halaqaInstructorId: 'i1',
          coveringInstructorId: 'i9',
          coveringInstructor: { fullName: 'أ. أنا' },
        },
        {
          halaqaInstructorId: 'i1',
          coveringInstructorId: 'i7',
          coveringInstructor: { fullName: 'أ. سعيد' },
        },
      ],
    });
    const res = await service.otherHalaqas(INSTRUCTOR, '2026-10-17');
    const [first, second] = res.halaqas;
    expect(first.coveredByMe).toBe(true);
    expect(first.coveredBy).toEqual([
      { instructorId: 'i9', instructorName: 'أ. أنا' },
      { instructorId: 'i7', instructorName: 'أ. سعيد' },
    ]);
    expect(second.coveredByMe).toBe(false);
    expect(second.coveredBy).toEqual([]);
  });

  it('reports the kind of day so the screen can warn before saving', async () => {
    const { service } = build({ own: { id: 'i9' } });
    // 2026-10-17 is a Saturday (ISO 6) — required in winter.
    await expect(
      service.otherHalaqas(INSTRUCTOR, '2026-10-17'),
    ).resolves.toMatchObject({ dayKind: 'REQUIRED' });
    // 2026-10-15 is a Thursday (ISO 4) — optional.
    await expect(
      service.otherHalaqas(INSTRUCTOR, '2026-10-15'),
    ).resolves.toMatchObject({ dayKind: 'OPTIONAL' });
  });

  it('shows an admin every حلقة, since an admin has no own حلقة', async () => {
    const { service, prisma } = build({ own: null });
    await service.otherHalaqas(ADMIN, '2026-10-17');
    expect(prisma.instructor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isHoldingPool: false,
          students: { some: { deletedAt: null } },
        },
      }),
    );
  });

  it('refuses a day that has not happened yet', async () => {
    const { service } = build({ own: { id: 'i9' } });
    await expect(service.otherHalaqas(INSTRUCTOR, '2099-01-01')).rejects.toThrow(
      /لم يأتِ بعد/,
    );
  });
});

describe('SubstituteService.halaqaRoster', () => {
  it('returns names only — no points, no phone numbers', async () => {
    const { service } = build({ own: { id: 'i9' } });
    const roster = await service.halaqaRoster(INSTRUCTOR, 'i1', '2026-10-17');
    expect(roster.instructorName).toBe('أ. أحمد');
    expect(roster.students).toEqual([
      { studentId: 's1', fullName: 'أحمد', fatherName: 'محمد' },
      { studentId: 's2', fullName: 'بلال', fatherName: 'سامر' },
    ]);
  });

  it('sends the instructor back to his own screen for his own حلقة', async () => {
    const { service } = build({ own: { id: 'i1' } });
    await expect(
      service.halaqaRoster(INSTRUCTOR, 'i1', '2026-10-17'),
    ).rejects.toThrow(/حلقتك/);
  });

  it('refuses «عزل»', async () => {
    const { service } = build({
      own: { id: 'i9' },
      halaqas: [{ id: 'iz', fullName: 'عزل', isHoldingPool: true, students: [] }],
    });
    await expect(
      service.halaqaRoster(INSTRUCTOR, 'iz', '2026-10-17'),
    ).rejects.toThrow(/عزل/);
  });

  it('refuses a حلقة that does not exist', async () => {
    const { service } = build({ own: { id: 'i9' } });
    await expect(
      service.halaqaRoster(INSTRUCTOR, 'nope', '2026-10-17'),
    ).rejects.toThrow(/غير موجودة/);
  });

  it('says whether this substitute already claimed the day', async () => {
    const claimed = build({ own: { id: 'i9' }, coverageFirst: { id: 'c1' } });
    await expect(
      claimed.service.halaqaRoster(INSTRUCTOR, 'i1', '2026-10-17'),
    ).resolves.toMatchObject({ coveredByMe: true });

    const open = build({ own: { id: 'i9' } });
    await expect(
      open.service.halaqaRoster(INSTRUCTOR, 'i1', '2026-10-17'),
    ).resolves.toMatchObject({ coveredByMe: false });
  });
});

describe('SubstituteService.claim', () => {
  it('records the claim against the caller own instructor id', async () => {
    const { service, prisma } = build({ own: { id: 'i9' } });
    const res = await service.claim(INSTRUCTOR, {
      halaqaInstructorId: 'i1',
      date: '2026-10-17',
      note: 'الأستاذ مسافر',
    });
    expect(prisma.halaqaCoverage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          halaqaInstructorId: 'i1',
          coveringInstructorId: 'i9',
          note: 'الأستاذ مسافر',
        }),
      }),
    );
    expect(res.coverage.coveringInstructorId).toBe('i9');
    expect(res.coverage.date).toBe('2026-10-17');
  });

  it('is idempotent: a second claim only refreshes the note', async () => {
    const { service, prisma } = build({ own: { id: 'i9' } });
    await service.claim(INSTRUCTOR, {
      halaqaInstructorId: 'i1',
      date: '2026-10-17',
    });
    const call = prisma.halaqaCoverage.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      halaqaInstructorId_coveringInstructorId_date: {
        halaqaInstructorId: 'i1',
        coveringInstructorId: 'i9',
        date: new Date('2026-10-17'),
      },
    });
    expect(call.update).toEqual({ note: null });
  });

  it('refuses claiming your own حلقة', async () => {
    const { service } = build({ own: { id: 'i1' } });
    await expect(
      service.claim(INSTRUCTOR, { halaqaInstructorId: 'i1', date: '2026-10-17' }),
    ).rejects.toThrow(/حلقتك/);
  });

  it('refuses an account with no instructor behind it, admin included', async () => {
    const { service } = build({ own: null });
    await expect(
      service.claim(ADMIN, { halaqaInstructorId: 'i1', date: '2026-10-17' }),
    ).rejects.toThrow(/الأستاذ من حسابه/);
  });
});

describe('SubstituteService.release', () => {
  it('deletes only this substitute claim for that day', async () => {
    const { service, prisma } = build({ own: { id: 'i9' } });
    const res = await service.release(INSTRUCTOR, {
      halaqaInstructorId: 'i1',
      date: '2026-10-17',
    });
    expect(prisma.halaqaCoverage.deleteMany).toHaveBeenCalledWith({
      where: {
        halaqaInstructorId: 'i1',
        coveringInstructorId: 'i9',
        date: new Date('2026-10-17'),
      },
    });
    expect(res.removed).toBe(1);
  });

  it('says so, rather than failing, when there was nothing to undo', async () => {
    const { service, prisma } = build({ own: { id: 'i9' } });
    prisma.halaqaCoverage.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      service.release(INSTRUCTOR, {
        halaqaInstructorId: 'i1',
        date: '2026-10-17',
      }),
    ).resolves.toMatchObject({ removed: 0 });
  });
});

describe('SubstituteService.coverage', () => {
  it('shows an instructor only his own claims', async () => {
    const { service, prisma } = build({ own: { id: 'i9' } });
    await service.coverage(INSTRUCTOR, '2026-10-17');
    expect(prisma.halaqaCoverage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { date: new Date('2026-10-17'), coveringInstructorId: 'i9' },
      }),
    );
  });

  it('shows an admin every claim of the day', async () => {
    const { service, prisma } = build({ own: null });
    await service.coverage(ADMIN, '2026-10-17');
    expect(prisma.halaqaCoverage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { date: new Date('2026-10-17') } }),
    );
  });
});
