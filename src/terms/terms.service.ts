import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTermDto } from './dto/create-term.dto';
import { UpdateTermDto } from './dto/update-term.dto';

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

  invalidateCache(): void {
    this.cache = null;
  }

  async findAll() {
    const terms = await this.prisma.term.findMany({
      orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }],
    });
    return { data: terms };
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
        },
      });
    });

    this.invalidateCache();
    return { message: 'تم إنشاء الدورة بنجاح', data: term };
  }

  async update(id: number, dto: UpdateTermDto) {
    await this.findOne(id); // 404 if missing

    const data: Record<string, unknown> = {};
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