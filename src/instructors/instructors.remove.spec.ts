import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InstructorsService } from './instructors.service';

// ═══════════════════════════════════════════════════════════════════════════
// Deleting an instructor
//
//   • active students            → refused (move them first)
//   • no history at all          → removed for good
//   • any history                → archived: sign-in off, hidden, username
//                                  released, every historical row untouched
//   • unknown foreign key on the
//     hard delete                → archived instead of an unhandled 500
// ═══════════════════════════════════════════════════════════════════════════

const INSTRUCTOR_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

type HistoryCounts = Partial<Record<string, number>>;

function buildService(opts: {
  found?: boolean;
  activeStudents?: number;
  history?: HistoryCounts;
  deleteError?: unknown;
}) {
  const { found = true, activeStudents = 0, history = {}, deleteError } = opts;
  const count = (model: string) => jest.fn(async () => history[model] ?? 0);

  const tx = {
    instructor: {
      delete: jest.fn(async () => {
        if (deleteError) throw deleteError;
        return {};
      }),
    },
    user: { delete: jest.fn(async () => ({})) },
  };

  const prisma: any = {
    instructor: {
      findFirst: jest.fn(async () =>
        found
          ? {
              id: INSTRUCTOR_ID,
              userId: USER_ID,
              user: { username: 'bilal' },
              _count: { students: activeStudents },
            }
          : null,
      ),
    },
    student: { count: count('student') },
    instructorAttendance: { count: count('instructorAttendance') },
    halaqaCoverage: { count: count('halaqaCoverage') },
    tempAssignment: { count: count('tempAssignment') },
    recitation: { count: count('recitation') },
    hadithRecitation: { count: count('hadithRecitation') },
    pointsLog: { count: count('pointsLog') },
    attendance: { count: count('attendance') },
    announcement: { count: count('announcement') },
    notification: { count: count('notification') },
    scheduledNotification: { count: count('scheduledNotification') },
    media: { count: count('media') },
    user: { update: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };

  return { service: new InstructorsService(prisma), prisma, tx };
}

describe('InstructorsService.remove', () => {
  it('refuses while the instructor still has active students', async () => {
    const { service, prisma, tx } = buildService({ activeStudents: 3 });
    await expect(service.remove(INSTRUCTOR_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.instructor.delete).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing or already-archived instructor', async () => {
    const { service } = buildService({ found: false });
    await expect(service.remove(INSTRUCTOR_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('only looks up instructors whose account is not archived', async () => {
    const { service, prisma } = buildService({});
    await service.remove(INSTRUCTOR_ID);
    expect(prisma.instructor.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INSTRUCTOR_ID, user: { deletedAt: null } },
      }),
    );
  });

  it('removes an account with no history for good', async () => {
    const { service, prisma, tx } = buildService({});
    const result = await service.remove(INSTRUCTOR_ID);

    expect(tx.instructor.delete).toHaveBeenCalledWith({
      where: { id: INSTRUCTOR_ID },
    });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: USER_ID } });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(result.archived).toBe(false);
  });

  it.each([
    'student', // a soft-deleted student still references the حلقة
    'instructorAttendance',
    'recitation',
    'pointsLog',
    'attendance',
  ])('archives instead of deleting when %s history exists', async (model) => {
    const { service, prisma, tx } = buildService({ history: { [model]: 1 } });
    const result = await service.remove(INSTRUCTOR_ID);

    expect(tx.instructor.delete).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        deletedAt: expect.any(Date),
        isActive: false,
        fcmToken: null,
        username: 'bilal#deleted-22222222',
      },
    });
    expect(result.archived).toBe(true);
  });

  it('archives when the hard delete hits an unknown foreign key', async () => {
    const fk = new Prisma.PrismaClientKnownRequestError('FK', {
      code: 'P2003',
      clientVersion: 'test',
    });
    const { service, prisma } = buildService({ deleteError: fk });
    const result = await service.remove(INSTRUCTOR_ID);

    expect(prisma.user.update).toHaveBeenCalled();
    expect(result.archived).toBe(true);
  });

  it('does not swallow errors other than a foreign-key violation', async () => {
    const { service, prisma } = buildService({
      deleteError: new Error('connection lost'),
    });
    await expect(service.remove(INSTRUCTOR_ID)).rejects.toThrow(
      'connection lost',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
