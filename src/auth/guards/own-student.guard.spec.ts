/* eslint-disable @typescript-eslint/no-unsafe-argument --
   Hand-rolled Prisma double is untyped by design. */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OwnStudentGuard } from './own-student.guard';

function contextFor(
  user: unknown,
  params: Record<string, string>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, params }) }),
  } as unknown as ExecutionContext;
}

function guardWith(own: { id: string; deletedAt: Date | null } | null) {
  const prisma: any = {
    student: { findUnique: jest.fn().mockResolvedValue(own) },
  };
  return { guard: new OwnStudentGuard(prisma), prisma };
}

const PARENT = { id: 'user-parent', role: 'STUDENT' };

describe('OwnStudentGuard', () => {
  it('lets a parent read his own child (either param name)', async () => {
    const { guard } = guardWith({ id: 'stu-1', deletedAt: null });
    await expect(
      guard.canActivate(contextFor(PARENT, { studentId: 'stu-1' })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor(PARENT, { id: 'stu-1' })),
    ).resolves.toBe(true);
  });

  it('refuses another child', async () => {
    const { guard } = guardWith({ id: 'stu-1', deletedAt: null });
    await expect(
      guard.canActivate(contextFor(PARENT, { studentId: 'stu-2' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an account with no student, a removed student, or no id at all', async () => {
    await expect(
      guardWith(null).guard.canActivate(contextFor(PARENT, { id: 'stu-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardWith({ id: 'stu-1', deletedAt: new Date() }).guard.canActivate(
        contextFor(PARENT, { id: 'stu-1' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guardWith({ id: 'stu-1', deletedAt: null }).guard.canActivate(
        contextFor(PARENT, {}),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves every other role to RolesGuard, without a database read', async () => {
    for (const role of ['ADMIN', 'INSTRUCTOR', 'SUPERVISOR']) {
      const { guard, prisma } = guardWith(null);
      await expect(
        guard.canActivate(contextFor({ id: 'u', role }, { studentId: 'any' })),
      ).resolves.toBe(true);
      expect(prisma.student.findUnique).not.toHaveBeenCalled();
    }
  });
});
