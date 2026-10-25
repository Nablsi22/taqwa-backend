/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return --
   Hand-rolled Prisma/stats/recitation doubles are untyped by design. */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { SupervisorDetailService } from './supervisor-detail.service';

// ═══════════════════════════════════════════════════════════════════════════
// Inside one حلقة, from the course director's side: the أستاذ's roster with
// points gained and deducted, what his students recited (Quran and hadith),
// his own presence, and — ADMIN only — the director's account.
// ═══════════════════════════════════════════════════════════════════════════

const ctx = {
  term: {
    id: 24,
    name: 'winter-2026-2027',
    nameAr: 'الشتوية',
    startDate: '2026-09-19',
    endDate: null,
    isActive: true,
  },
  meetingDays: { required: [6], optional: [4], source: 'COURSE' },
  today: '2026-10-24',
  measuredUntil: '2026-10-24',
  lastRequired: { scheduled: '2026-10-24', withRecords: '2026-10-24' },
};

function build(over: Record<string, any> = {}) {
  const prisma: any = {
    instructor: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'i1', fullName: 'أحمد حسن' }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'i1', userId: 'u1', fullName: 'أحمد حسن' }]),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([{ id: 'u1', username: 'AhmadH' }]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'sup1',
          username: data.username,
          isActive: true,
          lastLogin: null,
          createdAt: new Date(),
        }),
      ),
      update: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve({
          id: where.id,
          username: 'mudir',
          isActive: true,
          lastLogin: null,
          createdAt: new Date(),
        }),
      ),
    },
    student: {
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.instructorId
            ? [
                { id: 's1', fullName: 'محمد', fatherName: 'خالد' },
                { id: 's2', fullName: 'عمر', fatherName: 'سامر' },
              ]
            : [
                {
                  id: 's1',
                  fatherName: 'خالد',
                  school: 'ابن خلدون',
                  grade: 'السادس',
                },
                { id: 's2', fatherName: 'سامر', school: null, grade: 'الخامس' },
              ],
        ),
      ),
    },
    pointsLog: {
      groupBy: jest.fn().mockImplementation(({ by, where }: any) => {
        if (by[0] === 'sourceId') {
          return Promise.resolve([
            { sourceId: 'r1', _sum: { amount: new Prisma.Decimal(2.5) } },
          ]);
        }
        if (where.amount.gt === 0) {
          return Promise.resolve([
            { studentId: 's1', _sum: { amount: new Prisma.Decimal(23) } },
          ]);
        }
        return Promise.resolve([
          { studentId: 's1', _sum: { amount: new Prisma.Decimal(-7) } },
        ]);
      }),
    },
    recitation: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'r1',
          studentId: 's1',
          instructorId: 'u1',
          surahNumber: 67,
          surahNumbers: [],
          pagesRecited: 1,
          pagesCalculated: new Prisma.Decimal(1.25),
          isCompleteSura: false,
          rating: 'VERY_GOOD',
          homework: 'الملك 11–20',
          date: new Date('2026-10-24T00:00:00Z'),
          createdAt: new Date('2026-10-24T14:10:00Z'),
          startSurah: 67,
          startAya: 1,
          endSurah: 67,
          endAya: 10,
        },
      ]),
    },
    hadithRecitation: {
      findMany: jest.fn().mockResolvedValue([
        // 2026-10-23 22:30 UTC is already Saturday 24/10 01:30 in Damascus.
        {
          id: 'h1',
          studentId: 's2',
          instructorId: 'i1',
          hadithNumber: 3,
          pointsAwarded: 4,
          createdAt: new Date('2026-10-23T22:30:00Z'),
        },
        // Friday afternoon in Damascus: outside a Saturday-only range.
        {
          id: 'h2',
          studentId: 's2',
          instructorId: 'i1',
          hadithNumber: 2,
          pointsAwarded: 4,
          createdAt: new Date('2026-10-23T12:00:00Z'),
        },
      ]),
    },
    hadithPointsRule: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ hadithNumber: 3, title: 'بني الإسلام على خمس' }]),
    },
    instructorAttendance: {
      findMany: jest.fn().mockResolvedValue([
        {
          date: new Date('2026-10-17T00:00:00Z'),
          present: false,
          notes: 'مسافر',
        },
      ]),
    },
    ...over,
  };
  const stats: any = { courseContext: jest.fn().mockResolvedValue(ctx) };
  const recitation: any = {
    getInstructorOverview: jest.fn().mockResolvedValue({
      data: [
        {
          studentId: 's1',
          fullName: 'محمد',
          pointsBalance: 16,
          totalPagesMemorized: 12,
        },
        {
          studentId: 's2',
          fullName: 'عمر',
          pointsBalance: 0,
          totalPagesMemorized: 3,
        },
      ],
      termId: 24,
    }),
  };
  return {
    svc: new SupervisorDetailService(prisma, stats, recitation),
    prisma,
    stats,
    recitation,
  };
}

describe('SupervisorDetailService.roster', () => {
  it("is the أستاذ's own dashboard roster plus points gained / deducted, school and grade", async () => {
    const { svc, recitation, prisma } = build();
    const r = await svc.roster('i1');
    // The same figures the أستاذ sees, for the course being looked at.
    expect(recitation.getInstructorOverview).toHaveBeenCalledWith('i1', {
      termId: 24,
    });
    expect(r.data[0]).toMatchObject({
      studentId: 's1',
      pointsBalance: 16,
      pointsGained: 23,
      pointsDeducted: -7,
      fatherName: 'خالد',
      school: 'ابن خلدون',
      grade: 'السادس',
    });
    expect(r.data[1]).toMatchObject({
      pointsGained: 0,
      pointsDeducted: 0,
      school: null,
    });
    // Course-scoped, and split by sign.
    const calls = prisma.pointsLog.groupBy.mock.calls.map(
      (c: any[]) => c[0].where,
    );
    expect(calls).toEqual([
      expect.objectContaining({ termId: 24, amount: { gt: 0 } }),
      expect.objectContaining({ termId: 24, amount: { lt: 0 } }),
    ]);
  });

  it('refuses an unknown أستاذ', async () => {
    const { svc } = build({
      instructor: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(),
      },
    });
    await expect(svc.roster('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SupervisorDetailService.recitations', () => {
  it('defaults to the last session day and returns Quran and hadith, newest first', async () => {
    const { svc, prisma } = build();
    const r = await svc.recitations('i1', {});
    expect([r.from, r.to]).toEqual(['2026-10-24', '2026-10-24']);
    const where = prisma.recitation.findMany.mock.calls[0][0].where;
    expect(where.date.gte.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(where.date.lte.toISOString()).toBe('2026-10-24T00:00:00.000Z');

    expect(r.data.map((x) => x.id)).toEqual(['r1', 'h1']); // h2 is Friday in Damascus
    expect(r.data[0]).toMatchObject({
      kind: 'QURAN',
      date: '2026-10-24',
      studentName: 'محمد',
      suraNames: ['الملك'],
      startAya: 1,
      endAya: 10,
      pages: 1.25,
      rating: 'VERY_GOOD',
      points: 2.5,
      recordedBy: 'أحمد حسن',
    });
    expect(r.data[1]).toMatchObject({
      kind: 'HADITH',
      date: '2026-10-24',
      studentName: 'عمر',
      hadithNumber: 3,
      hadithTitle: 'بني الإسلام على خمس',
      points: 4,
    });
  });

  it('validates the range', async () => {
    const { svc } = build();
    await expect(
      svc.recitations('i1', { from: '2026-10-24', to: '2026-10-17' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.recitations('i1', { from: '2026-01-01', to: '2026-10-24' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.recitations('i1', { from: '2026-02-30' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns nothing for a حلقة with no students, without querying recitations', async () => {
    const { svc, prisma } = build({
      student: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const r = await svc.recitations('i1', {
      from: '2026-10-17',
      to: '2026-10-24',
    });
    expect(r.data).toEqual([]);
    expect(prisma.recitation.findMany).not.toHaveBeenCalled();
  });
});

describe('SupervisorDetailService.presence', () => {
  it("lists the أستاذ's presence in the course period, as calendar days", async () => {
    const { svc, prisma } = build();
    const r = await svc.presence('i1');
    expect(r.data).toEqual([
      { date: '2026-10-17', present: false, notes: 'مسافر' },
    ]);
    const where = prisma.instructorAttendance.findMany.mock.calls[0][0].where;
    expect(where.date.gte.toISOString().slice(0, 10)).toBe('2026-09-19');
    expect(where.date.lte.toISOString().slice(0, 10)).toBe('2026-10-24');
  });
});

describe('SupervisorDetailService accounts (ADMIN only)', () => {
  it('creates a SUPERVISOR user with a bcrypt hash, never storing the password', async () => {
    const { svc, prisma } = build();
    const r = await svc.createAccount('  mudir ', 'secret123');
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data.username).toBe('mudir');
    expect(data.role).toBe('SUPERVISOR');
    expect(data.passwordHash).not.toContain('secret123');
    expect(await bcrypt.compare('secret123', data.passwordHash)).toBe(true);
    expect(r.data).toMatchObject({ id: 'sup1', username: 'mudir' });
    expect(r.data).not.toHaveProperty('passwordHash');
  });

  it('refuses a username that already exists, of any role', async () => {
    const { svc } = build({
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'x', role: 'INSTRUCTOR' }),
        create: jest.fn(),
      },
    });
    await expect(
      svc.createAccount('AhmadH', 'secret123'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('changes the password of a director account only — never of another role', async () => {
    const { svc, prisma } = build({
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'u1', role: 'INSTRUCTOR', deletedAt: null }),
        update: jest.fn(),
      },
    });
    await expect(svc.setPassword('u1', 'newpass1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.setActive('u1', false)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('resets a director password with a fresh hash', async () => {
    const update = jest
      .fn()
      .mockResolvedValue({ id: 'sup1', username: 'mudir' });
    const { svc } = build({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sup1',
          role: 'SUPERVISOR',
          deletedAt: null,
        }),
        update,
      },
    });
    await svc.setPassword('sup1', 'newpass1');
    const { data } = update.mock.calls[0][0];
    expect(await bcrypt.compare('newpass1', data.passwordHash)).toBe(true);
  });
});
