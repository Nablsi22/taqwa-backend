import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A parent's account (role STUDENT) reads its own child's records only.
 *
 * The routes behind a child's page — attendance, points, rank, recitations,
 * homework — take the student id from the URL. RolesGuard lets a parent
 * reach them, but on its own it would let one parent read another child's
 * record by changing that id. This guard closes that: for a STUDENT token
 * the id in the URL must be the account's own student; every other role
 * passes through, its access being RolesGuard's decision.
 *
 * Apply it after JwtAuthGuard and RolesGuard (method-level @UseGuards runs
 * after the controller's), on routes whose student id is `:studentId` or
 * `:id`.
 *
 * Ref: OWASP API Security Top 10 — API1:2023 Broken Object Level Authorization
 *      https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class OwnStudentGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      user?: { id: string; role: string };
      params?: Record<string, string | undefined>;
    }>();
    const user = req.user;
    if (!user || user.role !== 'STUDENT') return true;

    const requested = req.params?.studentId ?? req.params?.id;
    const own = await this.prisma.student.findUnique({
      where: { userId: user.id },
      select: { id: true, deletedAt: true },
    });
    if (!requested || !own || own.deletedAt || own.id !== requested) {
      throw new ForbiddenException('يمكنك عرض بيانات حسابك فقط');
    }
    return true;
  }
}
