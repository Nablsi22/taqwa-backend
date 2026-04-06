import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PointRulesService } from '../point-rules/point-rules.service';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pointRulesService: PointRulesService,
  ) {}

  async markAttendance(dto: MarkAttendanceDto, markedByUserId: string) {
    const date = new Date(dto.date);
    const results: any[] = [];

    // Look up dedicated attendance categories first; fall back to generic
    // EARN/DEDUCT categories only if no attendance-specific ones exist.
    let earnCategoryId: string | null = null;
    let deductCategoryId: string | null = null;
    try {
      // Prefer a category whose name mentions حضور / attendance
      const attendanceEarn = await this.prisma.pointCategory.findFirst({
        where: {
          type: 'EARN',
          isActive: true,
          OR: [
            { nameAr: { contains: 'حضور' } },
            { nameAr: { contains: 'الحضور' } },
            { name: { contains: 'attendance', mode: 'insensitive' } },
          ],
        },
      });
      const attendanceDeduct = await this.prisma.pointCategory.findFirst({
        where: {
          type: 'DEDUCT',
          isActive: true,
          OR: [
            { nameAr: { contains: 'غياب' } },
            { nameAr: { contains: 'تأخير' } },
            { name: { contains: 'attendance', mode: 'insensitive' } },
            { name: { contains: 'absent', mode: 'insensitive' } },
          ],
        },
      });

      // Fall back to first generic EARN/DEDUCT if no attendance-specific
      // category exists yet.
      const fallbackEarn = attendanceEarn
        ? null
        : await this.prisma.pointCategory.findFirst({
            where: { type: 'EARN', isActive: true },
          });
      const fallbackDeduct = attendanceDeduct
        ? null
        : await this.prisma.pointCategory.findFirst({
            where: { type: 'DEDUCT', isActive: true },
          });

      earnCategoryId = (attendanceEarn ?? fallbackEarn)?.id || null;
      deductCategoryId = (attendanceDeduct ?? fallbackDeduct)?.id || null;
    } catch (_) {}

    for (const entry of dto.entries) {
      const student = await this.prisma.student.findUnique({
        where: { id: entry.studentId },
      });
      if (!student) {
        throw new BadRequestException(
          `الطالب غير موجود: ${entry.studentId}`,
        );
      }

      const existingRecord = await this.prisma.attendance.findUnique({
        where: {
          studentId_date: {
            studentId: entry.studentId,
            date,
          },
        },
      });

      const record = await this.prisma.attendance.upsert({
        where: {
          studentId_date: {
            studentId: entry.studentId,
            date,
          },
        },
        update: {
          status: entry.status,
          notes: entry.notes,
          markedBy: markedByUserId,
        },
        create: {
          studentId: entry.studentId,
          date,
          status: entry.status,
          notes: entry.notes,
          markedBy: markedByUserId,
        },
        include: {
          student: { select: { fullName: true } },
        },
      });

      // ═══════════════════════════════════════════════════════════
      // AUTO-POINTS: Only on NEW records (not updates).
      // Points are stamped with sourceId = attendance record ID so
      // they can be cascaded away if the attendance is ever deleted.
      // ═══════════════════════════════════════════════════════════
      if (!existingRecord) {
        try {
          const ruleResult = await this.pointRulesService.getAttendancePoints(
            entry.status as 'PRESENT' | 'LATE' | 'ABSENT',
          );

          if (ruleResult) {
            const categoryId =
              ruleResult.points >= 0 ? earnCategoryId : deductCategoryId;

            if (categoryId) {
              await this.prisma.pointsLog.create({
                data: {
                  studentId: entry.studentId,
                  categoryId,
                  amount: ruleResult.points,
                  description: `${ruleResult.ruleNameAr} - ${dto.date}`,
                  awardedBy: markedByUserId,
                  sourceId: record.id,
                  sourceType: 'ATTENDANCE',
                },
              });
            }
          }
        } catch (e) {
          console.error('Auto-points failed for attendance:', e);
        }
      }

      results.push(record);
    }

    return {
      message: `تم تسجيل حضور ${results.length} طالب`,
      count: results.length,
      data: results,
    };
  }

  async getByDate(date: string, instructorId?: string) {
    const where: any = {
      date: new Date(date),
    };
    if (instructorId) {
      where.student = { instructorId };
    }
    const records = await this.prisma.attendance.findMany({
      where,
      include: {
        student: { select: { id: true, fullName: true, instructorId: true } },
      },
      orderBy: { student: { fullName: 'asc' } },
    });
    return records;
  }

  async getAttendanceSheet(date: string, instructorId?: string) {
    const studentWhere: any = { deletedAt: null };
    if (instructorId) {
      studentWhere.instructorId = instructorId;
    }
    const students = await this.prisma.student.findMany({
      where: studentWhere,
      orderBy: { fullName: 'asc' },
      select: { id: true, fullName: true, instructorId: true },
    });
    const existingRecords = await this.prisma.attendance.findMany({
      where: {
        date: new Date(date),
        studentId: { in: students.map((s) => s.id) },
      },
    });
    const recordMap = new Map(existingRecords.map((r) => [r.studentId, r]));
    const sheet = students.map((student) => {
      const record = recordMap.get(student.id);
      return {
        studentId: student.id,
        fullName: student.fullName,
        status: record?.status || null,
        notes: record?.notes || null,
        isMarked: !!record,
      };
    });
    return {
      date,
      totalStudents: students.length,
      markedCount: existingRecords.length,
      unmarkedCount: students.length - existingRecords.length,
      students: sheet,
    };
  }

  async getStudentHistory(
    studentId: string,
    params?: {
      page?: number;
      limit?: number;
      month?: string;
    },
  ) {
    const { page = 1, limit = 30, month } = params || {};
    const skip = (page - 1) * limit;
    const where: any = { studentId };
    if (month) {
      const [year, m] = month.split('-').map(Number);
      where.date = {
        gte: new Date(year, m - 1, 1),
        lt: new Date(year, m, 1),
      };
    }
    const [records, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.attendance.count({ where }),
    ]);
    const summary = await this.prisma.attendance.groupBy({
      by: ['status'],
      where: { studentId },
      _count: true,
    });
    return {
      data: records,
      summary: {
        present: summary.find((s) => s.status === 'PRESENT')?._count || 0,
        late: summary.find((s) => s.status === 'LATE')?._count || 0,
        absent: summary.find((s) => s.status === 'ABSENT')?._count || 0,
      },
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDayStats(date: string) {
    const dateObj = new Date(date);
    const totalStudents = await this.prisma.student.count({
      where: { deletedAt: null },
    });
    const stats = await this.prisma.attendance.groupBy({
      by: ['status'],
      where: { date: dateObj },
      _count: true,
    });
    return {
      date,
      totalStudents,
      present: stats.find((s) => s.status === 'PRESENT')?._count || 0,
      late: stats.find((s) => s.status === 'LATE')?._count || 0,
      absent: stats.find((s) => s.status === 'ABSENT')?._count || 0,
      unmarked: totalStudents - stats.reduce((sum, s) => sum + s._count, 0),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // DELETE ATTENDANCE — cascades the awarded points too
  // ═══════════════════════════════════════════════════════════

  async deleteAttendance(id: string) {
    const record = await this.prisma.attendance.findUnique({
      where: { id },
    });

    if (!record) {
      throw new NotFoundException('سجل الحضور غير موجود');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const deletedPoints = await tx.pointsLog.deleteMany({
        where: {
          sourceType: 'ATTENDANCE',
          sourceId: id,
        },
      });

      await tx.attendance.delete({ where: { id } });

      return { deletedPointsCount: deletedPoints.count };
    });

    return {
      message:
        result.deletedPointsCount > 0
          ? `تم حذف سجل الحضور وإلغاء ${result.deletedPointsCount} نقطة مرتبطة به`
          : 'تم حذف سجل الحضور بنجاح',
    };
  }
}