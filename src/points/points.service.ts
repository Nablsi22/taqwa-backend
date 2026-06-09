import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TermsService } from '../terms/terms.service';
import { AwardPointsDto } from './dto/award-points.dto';

/**
 * DTO for the manual award endpoint. Either `ruleId` (for predefined
 * rules — amount comes from the rule, locked) OR (`amount` + `reason`)
 * for free-form custom points. Never both.
 */
export interface AwardManualPointsInput {
  studentId: string;
  ruleId?: string;
  amount?: number;
  reason?: string;
}

@Injectable()
export class PointsService {
  // Hard cap on custom point amounts to prevent runaway typos.
  private static readonly MAX_CUSTOM_POINTS = 9999;

  constructor(
    private readonly prisma: PrismaService,
    private readonly termsService: TermsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // TERM FILTER RESOLVER
  //
  // Resolves which term to filter points queries by:
  //   • explicit === undefined → currently-active term (default; this is
  //                              what student APKs hit, giving them the
  //                              "fresh start" view)
  //   • explicit === 0         → no filter (admin viewing full history)
  //   • explicit > 0           → that specific term id
  // ═══════════════════════════════════════════════════════════════════════
  private async resolveTermWhere(
    explicit?: number | null,
  ): Promise<Prisma.PointsLogWhereInput> {
    if (explicit === 0) return {};
    if (typeof explicit === 'number' && explicit > 0) {
      return { termId: explicit };
    }
    const active = await this.termsService.getActiveTermId();
    if (active == null) return {}; // no active term: safety fallback
    return { termId: active };
  }

  // ─────────────────────────────────────────────────────────────────────
  // CATEGORIES (unchanged)
  // ─────────────────────────────────────────────────────────────────────
  async getCategories() {
    const categories = await this.prisma.pointCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    return { data: categories };
  }

  // ─────────────────────────────────────────────────────────────────────
  // LEGACY AWARD (unchanged — DB trigger fills term_id)
  // ─────────────────────────────────────────────────────────────────────
  async awardPoints(dto: AwardPointsDto, awardedByUserId: string) {
    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student || student.deletedAt) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const category = await this.prisma.pointCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category || !category.isActive) {
      throw new NotFoundException('فئة النقاط غير موجودة أو غير مفعّلة');
    }

    let amount = dto.amount;
    if (category.hasRating && dto.rating === 'REPEAT') amount = 0;
    if (category.type === 'DEDUCT' && amount > 0) amount = -amount;

    const log = await this.prisma.pointsLog.create({
      data: {
        studentId: dto.studentId,
        categoryId: dto.categoryId,
        amount,
        rating: dto.rating || null,
        description: dto.description || category.nameAr || category.name,
        awardedBy: awardedByUserId,
        sourceType: 'MANUAL',
      },
      include: {
        student: { select: { fullName: true } },
        category: { select: { name: true, nameAr: true } },
      },
    });

    return {
      message:
        amount >= 0
          ? `تم إضافة ${amount} نقطة للطالب ${log.student.fullName}`
          : `تم خصم ${Math.abs(amount)} نقطة من الطالب ${log.student.fullName}`,
      data: {
        id: log.id,
        studentName: log.student.fullName,
        categoryName: log.category.nameAr || log.category.name,
        amount: log.amount,
        rating: log.rating,
        description: log.description,
        createdAt: log.createdAt,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // MANUAL AWARD (unchanged — DB trigger fills term_id)
  // ─────────────────────────────────────────────────────────────────────
  async awardManualPoints(
    input: AwardManualPointsInput,
    awardedByUserId: string,
  ) {
    const student = await this.prisma.student.findUnique({
      where: { id: input.studentId },
    });
    if (!student || student.deletedAt) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const hasRule = !!input.ruleId;
    const hasCustom =
      input.amount !== undefined &&
      input.amount !== null &&
      input.reason !== undefined &&
      input.reason !== null &&
      String(input.reason).trim().length > 0;

    if (hasRule && hasCustom) {
      throw new BadRequestException(
        'لا يمكن إرسال قاعدة ونقاط مخصصة في نفس الوقت',
      );
    }
    if (!hasRule && !hasCustom) {
      throw new BadRequestException(
        'يجب اختيار قاعدة أو إدخال نقاط مخصصة مع السبب',
      );
    }

    let finalAmount: number;
    let finalDescription: string;

    if (hasRule) {
      const rule = await this.prisma.pointRule.findUnique({
        where: { id: input.ruleId! },
      });
      if (!rule || !rule.isActive) {
        throw new NotFoundException('القاعدة غير موجودة أو غير مفعّلة');
      }
      if (rule.isAutomatic) {
        throw new BadRequestException(
          'لا يمكن تطبيق هذه القاعدة يدوياً (قاعدة تلقائية)',
        );
      }
      finalAmount = rule.points;
      finalDescription = rule.nameAr;
    } else {
      const rawAmount = Number(input.amount);
      if (!Number.isFinite(rawAmount) || rawAmount === 0) {
        throw new BadRequestException('يرجى إدخال عدد نقاط صالح (غير صفر)');
      }
      if (Math.abs(rawAmount) > PointsService.MAX_CUSTOM_POINTS) {
        throw new BadRequestException(
          `الحد الأقصى للنقاط المخصصة هو ${PointsService.MAX_CUSTOM_POINTS}`,
        );
      }
      finalAmount = Math.trunc(rawAmount);
      finalDescription = String(input.reason).trim();
    }

    const neededType = finalAmount >= 0 ? 'EARN' : 'DEDUCT';
    let category = await this.prisma.pointCategory.findFirst({
      where: { type: neededType, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!category) {
      category = await this.prisma.pointCategory.findFirst({
        where: { isActive: true },
      });
    }
    if (!category) {
      throw new BadRequestException(
        'لا توجد فئات نقاط مفعّلة في النظام. يرجى إضافة فئة من لوحة الإدارة.',
      );
    }

    const log = await this.prisma.pointsLog.create({
      data: {
        studentId: input.studentId,
        categoryId: category.id,
        amount: finalAmount,
        description: finalDescription,
        awardedBy: awardedByUserId,
        sourceType: 'MANUAL',
      },
      include: { student: { select: { fullName: true } } },
    });

    return {
      message:
        finalAmount >= 0
          ? `تم إضافة ${finalAmount} نقطة للطالب ${log.student.fullName}`
          : `تم خصم ${Math.abs(finalAmount)} نقطة من الطالب ${log.student.fullName}`,
      data: {
        id: log.id,
        studentName: log.student.fullName,
        amount: log.amount,
        description: log.description,
        sourceType: log.sourceType,
        createdAt: log.createdAt,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GET STUDENT POINTS — ◄── FILTERED to active term by default
  //
  // Student APKs (which don't pass termId) receive only active-term data,
  // creating the "fresh start" effect without any client-side change.
  // Admin/instructor APKs can pass `?termId=0` for full history or
  // `?termId=<id>` for a specific past term.
  // ═══════════════════════════════════════════════════════════════════════
  async getStudentPoints(
    studentId: string,
    params?: { page?: number; limit?: number; termId?: number | null },
  ) {
    const { page = 1, limit = 30, termId } = params || {};
    const skip = (page - 1) * limit;

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
    });
    if (!student || student.deletedAt) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const termWhere = await this.resolveTermWhere(termId);
    const baseWhere: Prisma.PointsLogWhereInput = { studentId, ...termWhere };

    const [logs, total, totalPointsAgg] = await Promise.all([
      this.prisma.pointsLog.findMany({
        where: baseWhere,
        include: {
          category: { select: { name: true, nameAr: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.pointsLog.count({ where: baseWhere }),
      this.prisma.pointsLog.aggregate({
        where: baseWhere,
        _sum: { amount: true },
      }),
    ]);

    const totalPointsNumber = Number(totalPointsAgg._sum.amount ?? 0);

    return {
      student: {
        id: student.id,
        fullName: student.fullName,
      },
      totalPoints: totalPointsNumber,
      data: logs.map((log) => {
        const sourceTypeKey = this.normalizeSourceType(log.sourceType);
        const displayLabel = this.labelForSourceType(sourceTypeKey);
        return {
          id: log.id,
          description:
            log.description ||
            log.category?.nameAr ||
            log.category?.name ||
            '',
          displayLabel,
          sourceType: sourceTypeKey,
          categoryName: log.category?.nameAr || log.category?.name || '',
          categoryType: log.category?.type || null,
          amount: Number(log.amount),
          rating: log.rating,
          createdAt: log.createdAt,
        };
      }),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private normalizeSourceType(
    raw: string | null | undefined,
  ): 'MANUAL' | 'RECITATION' | 'ATTENDANCE' {
    if (raw === 'RECITATION') return 'RECITATION';
    if (raw === 'ATTENDANCE') return 'ATTENDANCE';
    return 'MANUAL';
  }

  private labelForSourceType(
    key: 'MANUAL' | 'RECITATION' | 'ATTENDANCE',
  ): string {
    switch (key) {
      case 'RECITATION': return 'تسميع';
      case 'ATTENDANCE': return 'حضور';
      case 'MANUAL':
      default:           return 'نقاط خاصة';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LEADERBOARD — ◄── FILTERED to active term by default
  // ═══════════════════════════════════════════════════════════════════════
  async getLeaderboard(params?: {
    limit?: number;
    instructorId?: string;
    termId?: number | null;
  }) {
    const { limit = 20, instructorId, termId } = params || {};

    const studentWhere: Prisma.StudentWhereInput = { deletedAt: null };
    if (instructorId) studentWhere.instructorId = instructorId;

    const termWhere = await this.resolveTermWhere(termId);

    const students = await this.prisma.student.findMany({
      where: studentWhere,
      select: {
        id: true,
        fullName: true,
        instructorId: true,
        instructor: { select: { fullName: true } },
        pointsLog: {
          where: termWhere,
          select: { amount: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    const ranked = students
      .map((s) => ({
        id: s.id,
        fullName: s.fullName,
        instructorName: s.instructor.fullName,
        totalPoints: s.pointsLog.reduce(
          (sum, p) => sum + Number(p.amount),
          0,
        ),
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, limit)
      .map((s, index) => ({ ...s, rank: index + 1 }));

    return { data: ranked };
  }

  // ─────────────────────────────────────────────────────────────────────
  // DELETE LOG (unchanged)
  // ─────────────────────────────────────────────────────────────────────
  async deleteLog(logId: string) {
    const log = await this.prisma.pointsLog.findUnique({
      where: { id: logId },
    });
    if (!log) throw new NotFoundException('سجل النقاط غير موجود');

    await this.prisma.pointsLog.delete({ where: { id: logId } });
    return { message: 'تم حذف سجل النقاط بنجاح' };
  }

  // ─────────────────────────────────────────────────────────────────────
  // UPDATE CATEGORY (unchanged)
  // ─────────────────────────────────────────────────────────────────────
  async updateCategory(
    id: string,
    data: {
      defaultValue?: number;
      nameAr?: string;
      isActive?: boolean;
      hasRating?: boolean;
    },
  ) {
    const category = await this.prisma.pointCategory.findUnique({
      where: { id },
    });
    if (!category) throw new NotFoundException('الفئة غير موجودة');

    const updateData: Record<string, unknown> = {};

    if (data.defaultValue !== undefined) {
      const numVal = Number(data.defaultValue);
      if (isNaN(numVal) || !Number.isInteger(numVal)) {
        throw new BadRequestException(
          'القيمة الافتراضية يجب أن تكون عدد صحيح',
        );
      }
      updateData.defaultValue = numVal;
    }
    if (data.nameAr !== undefined) updateData.nameAr = String(data.nameAr);
    if (data.isActive !== undefined) {
      updateData.isActive = Boolean(data.isActive);
    }
    if (data.hasRating !== undefined) {
      updateData.hasRating = Boolean(data.hasRating);
    }

    try {
      const updated = await this.prisma.pointCategory.update({
        where: { id },
        data: updateData,
      });
      return { message: 'تم تحديث الفئة بنجاح', data: updated };
    } catch (error: any) {
      console.error('updateCategory Prisma error:', error);
      throw new BadRequestException(
        `فشل تحديث الفئة: ${error.message || error}`,
      );
    }
  }
}