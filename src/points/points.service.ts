import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AwardPointsDto } from './dto/award-points.dto';

@Injectable()
export class PointsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get all active point categories
   */
  async getCategories() {
    const categories = await this.prisma.pointCategory.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });

    return { data: categories };
  }

  /**
   * Award points to a student
   */
  async awardPoints(dto: AwardPointsDto, awardedByUserId: string) {
    // Verify student exists
    const student = await this.prisma.student.findUnique({
      where: { id: dto.studentId },
    });
    if (!student || student.deletedAt) {
      throw new NotFoundException('الطالب غير موجود');
    }

    // Verify category exists
    const category = await this.prisma.pointCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category || !category.isActive) {
      throw new NotFoundException('فئة النقاط غير موجودة أو غير مفعلة');
    }

    // Determine amount
    let amount = dto.amount;

    // If category has rating and rating is REPEAT, set points to 0
    if (category.hasRating && dto.rating === 'REPEAT') {
      amount = 0;
    }

    // For DEDUCT type, make amount negative
    if (category.type === 'DEDUCT' && amount > 0) {
      amount = -amount;
    }

    const log = await this.prisma.pointsLog.create({
      data: {
        studentId: dto.studentId,
        categoryId: dto.categoryId,
        amount,
        rating: dto.rating || null,
        description: dto.description || null,
        awardedBy: awardedByUserId,
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

  /**
   * Get points history for a student
   */
  async getStudentPoints(
    studentId: string,
    params?: { page?: number; limit?: number },
  ) {
    const { page = 1, limit = 30 } = params || {};
    const skip = (page - 1) * limit;

    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
    });
    if (!student || student.deletedAt) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const [logs, total] = await Promise.all([
      this.prisma.pointsLog.findMany({
        where: { studentId },
        include: {
          category: { select: { name: true, nameAr: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.pointsLog.count({ where: { studentId } }),
    ]);

    // Calculate total points
    const totalPoints = await this.prisma.pointsLog.aggregate({
      where: { studentId },
      _sum: { amount: true },
    });

    return {
      student: {
        id: student.id,
        fullName: student.fullName,
      },
      totalPoints: totalPoints._sum.amount || 0,
      data: logs.map((log) => ({
        id: log.id,
        categoryName: log.category.nameAr || log.category.name,
        categoryType: log.category.type,
        amount: log.amount,
        rating: log.rating,
        description: log.description,
        createdAt: log.createdAt,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get leaderboard — students ranked by total points
   */
  async getLeaderboard(params?: { limit?: number; instructorId?: string }) {
    const { limit = 20, instructorId } = params || {};

    const where: any = { deletedAt: null };
    if (instructorId) {
      where.instructorId = instructorId;
    }

    const students = await this.prisma.student.findMany({
      where,
      select: {
        id: true,
        fullName: true,
        instructorId: true,
        instructor: { select: { fullName: true } },
        pointsLog: {
          select: { amount: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });

    // Calculate totals and sort
    const ranked = students
      .map((s) => ({
        id: s.id,
        fullName: s.fullName,
        instructorName: s.instructor.fullName,
        totalPoints: s.pointsLog.reduce((sum, p) => sum + p.amount, 0),
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints)
      .slice(0, limit)
      .map((s, index) => ({
        ...s,
        rank: index + 1,
      }));

    return { data: ranked };
  }

  /**
   * Delete a points log entry (admin only)
   */
  async deleteLog(logId: string) {
    const log = await this.prisma.pointsLog.findUnique({
      where: { id: logId },
    });
    if (!log) {
      throw new NotFoundException('سجل النقاط غير موجود');
    }

    await this.prisma.pointsLog.delete({ where: { id: logId } });

    return { message: 'تم حذف سجل النقاط بنجاح' };
  }

  /**
   * Update a point category (admin only)
   */
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
    if (!category) {
      throw new NotFoundException('الفئة غير موجودة');
    }

    // Build update payload with explicit type safety
    const updateData: Record<string, any> = {};

    if (data.defaultValue !== undefined) {
      const numVal = Number(data.defaultValue);
      if (isNaN(numVal) || !Number.isInteger(numVal)) {
        throw new BadRequestException(
          'القيمة الافتراضية يجب أن تكون عدد صحيح',
        );
      }
      updateData.defaultValue = numVal;
    }
    if (data.nameAr !== undefined) {
      updateData.nameAr = String(data.nameAr);
    }
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
    } catch (error) {
      console.error('updateCategory Prisma error:', error);
      throw new BadRequestException(
        `فشل تحديث الفئة: ${error.message || error}`,
      );
    }
  }
}