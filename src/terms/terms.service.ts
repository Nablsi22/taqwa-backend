import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTermDto } from './dto/create-term.dto';
import { UpdateTermDto } from './dto/update-term.dto';

/**
 * Validated meeting days, sorted. A weekday cannot be both required and
 * optional (also enforced in the database by terms_meeting_days_chk).
 */
export function normalizeMeetingDays(required: number[], optional: number[]): { requiredDays: number[]; optionalDays: number[] } {
  const requiredDays = [...new Set(required)].sort((a, b) => a - b);
  const optionalDays = [...new Set(optional)].sort((a, b) => a - b);
  if (requiredDays.some((d) => optionalDays.includes(d))) {
    throw new BadRequestException('لا يمكن أن يكون اليوم نفسه إلزامياً واختيارياً معاً');
  }
  return { requiredDays, optionalDays };
}

@Injectable()
export class TermsService {
  /**
   * Active-term cache. Filtering EVERY points/leaderboard query by
   * activeTermId would otherwise hit the DB once per request. TTL is short
   * so "activate term" actions take effect within seconds across instances.
   */
  private cache: { termId: number | null; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────
  // Read paths
  // ─────────────────────────────────────────────────────────────────────

  async getActiveTermId(): Promise<number | null> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.termId;

    const term = await this.prisma.term.findFirst({
      where:  { isActive: true },
      select: { id: true },
    });
    this.cache = {
      termId:    term?.id ?? null,
      expiresAt: now + TermsService.CACHE_TTL_MS,
    };
    return this.cache.termId;
  }

  /**
   * Active-course id, or a 400 when there is none.
   *
   * Every write that produces points (recitation, hadith, manual award,
   * attendance) goes through here first, so a points row can never be
   * created outside a course. The DB backs this up with
   * `points_log_term_required_chk` / `recitations_term_required_chk`; this
   * exists so the instructor sees an actionable Arabic message instead of a
   * raw constraint violation.
   */
  async requireActiveTermId(): Promise<number> {
    const id = await this.getActiveTermId();
    if (id == null) {
      throw new BadRequestException(
        'لا توجد دورة مفعّلة حالياً. يرجى تفعيل دورة من شاشة إدارة الدورات قبل تسجيل أي نقاط أو تسميع.',
      );
    }
    return id;
  }

  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Every course, active first then newest. Each row carries the counters the
   * management screen shows, so listing courses is one round-trip instead of
   * one `GET /terms/:id/stats` per row.
   */
  async findAll() {
    const terms = await this.prisma.term.findMany({
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
    });
    if (terms.length === 0) return { data: [] };

    const ids = terms.map((t) => t.id);
    const [pointsByTerm, recitationsByTerm, studentsByTerm] = await Promise.all([
      this.prisma.pointsLog.groupBy({
        by: ['termId'],
        where: { termId: { in: ids } },
        _sum: { amount: true },
      }),
      this.prisma.recitation.groupBy({
        by: ['termId'],
        where: { termId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.pointsLog.findMany({
        where: { termId: { in: ids } },
        select: { termId: true, studentId: true },
        distinct: ['termId', 'studentId'],
      }),
    ]);

    const points = new Map<number, number>();
    for (const row of pointsByTerm) {
      if (row.termId != null) points.set(row.termId, Number(row._sum.amount ?? 0));
    }
    const recitations = new Map<number, number>();
    for (const row of recitationsByTerm) {
      if (row.termId != null) recitations.set(row.termId, row._count._all);
    }
    const students = new Map<number, number>();
    for (const row of studentsByTerm) {
      if (row.termId != null) {
        students.set(row.termId, (students.get(row.termId) ?? 0) + 1);
      }
    }

    return {
      data: terms.map((t) => ({
        ...t,
        totalPoints: points.get(t.id) ?? 0,
        recitationCount: recitations.get(t.id) ?? 0,
        activeStudentCount: students.get(t.id) ?? 0,
      })),
    };
  }

  async findActive() {
    const term = await this.prisma.term.findFirst({
      where: { isActive: true },
    });
    if (!term) throw new NotFoundException('لا توجد دورة مفعّلة حالياً');
    return { data: term };
  }

  async findOne(id: number) {
    const term = await this.prisma.term.findUnique({ where: { id } });
    if (!term) throw new NotFoundException('الدورة غير موجودة');
    return { data: term };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Mutating paths (admin only — enforced in controller)
  // ─────────────────────────────────────────────────────────────────────

  async create(dto: CreateTermDto) {
    const startDate = new Date(dto.startDate);
    const endDate   = dto.endDate ? new Date(dto.endDate) : null;

    if (endDate && endDate < startDate) {
      throw new BadRequestException('تاريخ النهاية يجب أن يكون بعد البداية');
    }

    const exists = await this.prisma.term.findUnique({
      where: { name: dto.name },
    });
    if (exists) {
      throw new BadRequestException(`الاسم "${dto.name}" مستخدم سابقاً`);
    }

    // Starting a course NEVER copies, resets or deletes anything: students,
    // their history and every previous course's points stay exactly where
    // they are. A new course simply has no points_log rows yet, so every
    // student's balance in it reads 0. That is the whole mechanism.
    const term = await this.prisma.$transaction(async (tx) => {
      if (dto.isActive === true) {
        await tx.term.updateMany({
          where: { isActive: true },
          data:  { isActive: false, endDate: new Date() },
        });
      }
      return tx.term.create({
        data: {
          name:      dto.name,
          nameAr:    dto.nameAr,
          startDate,
          endDate,
          isActive:  dto.isActive ?? false,
          ...normalizeMeetingDays(dto.requiredDays ?? [], dto.optionalDays ?? []),
        },
      });
    });

    this.invalidateCache();
    return { message: 'تم إنشاء الدورة بنجاح', data: term };
  }

  async update(id: number, dto: UpdateTermDto) {
    const { data: current } = await this.findOne(id); // 404 if missing

    const data: Record<string, unknown> = {};
    if (dto.requiredDays !== undefined || dto.optionalDays !== undefined) {
      Object.assign(
        data,
        normalizeMeetingDays(dto.requiredDays ?? current.requiredDays, dto.optionalDays ?? current.optionalDays),
      );
    }
    if (dto.nameAr    !== undefined) data.nameAr    = dto.nameAr;
    if (dto.startDate !== undefined) data.startDate = new Date(dto.startDate);
    if (dto.endDate   !== undefined) {
      data.endDate = dto.endDate === null ? null : new Date(dto.endDate);
    }

    const term = await this.prisma.term.update({ where: { id }, data });
    this.invalidateCache();
    return { message: 'تم تحديث الدورة بنجاح', data: term };
  }

  /**
   * Atomically deactivate any currently-active term and activate the
   * requested one. Enforces the "exactly one active term" invariant
   * already guarded at the DB level by terms_only_one_active_idx.
   */
  async activate(id: number) {
    const { data: target } = await this.findOne(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.term.updateMany({
        where: { isActive: true, id: { not: id } },
        data:  { isActive: false, endDate: new Date() },
      });
      return tx.term.update({
        where: { id },
        data:  { isActive: true, endDate: null },
      });
    });

    this.invalidateCache();
    return { message: `تم تفعيل "${target.nameAr}"`, data: updated };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Per-term stats (for admin dashboards)
  // ─────────────────────────────────────────────────────────────────────

  async getStats(id: number) {
    const { data: term } = await this.findOne(id);

    const [recitationCount, pointsAgg, activeStudents] = await Promise.all([
      this.prisma.recitation.count({ where: { termId: id } }),
      this.prisma.pointsLog.aggregate({
        where: { termId: id },
        _sum:  { amount: true },
      }),
      this.prisma.recitation
        .groupBy({ by: ['studentId'], where: { termId: id } })
        .then((rows) => rows.length),
    ]);

    return {
      data: {
        term,
        recitationCount,
        activeStudentCount: activeStudents,
        totalPoints:        Number(pointsAgg._sum.amount ?? 0),
      },
    };
  }
}