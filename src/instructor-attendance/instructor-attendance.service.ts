import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InstructorAttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════
  // RESOLVE INSTRUCTOR ID — from userId to instructorId
  // ═══════════════════════════════════════════════════════════
  private async resolveInstructorId(userId: string): Promise<string> {
    const instructor = await this.prisma.instructor.findUnique({
      where: { userId },
    });
    if (!instructor)
      throw new NotFoundException('المعلم غير موجود');
    return instructor.id;
  }

  // ═══════════════════════════════════════════════════════════
  // MARK INSTRUCTOR ATTENDANCE — admin marks one instructor
  // ═══════════════════════════════════════════════════════════
  async markAttendance(dto: {
    instructorId: string;
    date: string;
    present: boolean;
    notes?: string;
  }) {
    const dateObj = new Date(dto.date);

    // Verify instructor exists
    const instructor = await this.prisma.instructor.findUnique({
      where: { id: dto.instructorId },
    });
    if (!instructor)
      throw new NotFoundException('المعلم غير موجود');

    // Upsert — update if exists, create if new
    const record = await this.prisma.instructorAttendance.upsert({
      where: {
        instructorId_date: {
          instructorId: dto.instructorId,
          date: dateObj,
        },
      },
      update: {
        present: dto.present,
      },
      create: {
        instructorId: dto.instructorId,
        date: dateObj,
        present: dto.present,
      },
    });

    return {
      message: dto.present ? 'تم تسجيل حضور المعلم' : 'تم تسجيل غياب المعلم',
      data: record,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // MARK BULK — admin marks all instructors for a given date
  // ═══════════════════════════════════════════════════════════
  async markBulk(dto: {
    date: string;
    entries: Array<{
      instructorId: string;
      present: boolean;
      notes?: string;
    }>;
  }) {
    const dateObj = new Date(dto.date);
    const results = [];

    for (const entry of dto.entries) {
      const record = await this.prisma.instructorAttendance.upsert({
        where: {
          instructorId_date: {
            instructorId: entry.instructorId,
            date: dateObj,
          },
        },
        update: {
          present: entry.present,
        },
        create: {
          instructorId: entry.instructorId,
          date: dateObj,
          present: entry.present,
        },
      });
      results.push(record);
    }

    return {
      message: `تم حفظ حضور ${results.length} معلم`,
      data: results,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // GET SHEET — all instructors with attendance for a date
  // ═══════════════════════════════════════════════════════════
  async getSheet(date: string) {
    const dateObj = new Date(date);

    const instructors = await this.prisma.instructor.findMany({
      where: {
        user: { deletedAt: null, isActive: true },
      },
      include: {
        user: { select: { username: true, isActive: true } },
        _count: { select: { students: true } },
      },
      orderBy: { fullName: 'asc' },
    });

    const records = await this.prisma.instructorAttendance.findMany({
      where: { date: dateObj },
    });

    const recordMap = new Map(records.map((r) => [r.instructorId, r]));

    const sheet = instructors.map((inst) => {
      const record = recordMap.get(inst.id);
      return {
        instructorId: inst.id,
        fullName: inst.fullName,
        studentCount: inst._count.students,
        present: record?.present ?? null,
      };
    });

    return {
      date,
      totalInstructors: instructors.length,
      markedCount: records.length,
      sheet,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // GET INSTRUCTOR HISTORY — attendance log for one instructor
  // ═══════════════════════════════════════════════════════════
  async getInstructorHistory(
    instructorId: string,
    params?: { page?: number; limit?: number; month?: string },
  ) {
    const { page = 1, limit = 30, month } = params || {};
    const skip = (page - 1) * limit;

    const where: any = { instructorId };

    if (month) {
      const [year, m] = month.split('-').map(Number);
      where.date = {
        gte: new Date(year, m - 1, 1),
        lt: new Date(year, m, 1),
      };
    }

    const [records, total] = await Promise.all([
      this.prisma.instructorAttendance.findMany({
        where,
        skip,
        take: limit,
        orderBy: { date: 'desc' },
      }),
      this.prisma.instructorAttendance.count({ where }),
    ]);

    // Summary counts
    const allRecords = await this.prisma.instructorAttendance.findMany({
      where: { instructorId },
    });
    const presentCount = allRecords.filter((r) => r.present).length;
    const absentCount = allRecords.filter((r) => !r.present).length;

    // Get instructor name
    const instructor = await this.prisma.instructor.findUnique({
      where: { id: instructorId },
      select: { fullName: true },
    });

    return {
      instructor: {
        id: instructorId,
        fullName: instructor?.fullName ?? '',
      },
      summary: {
        totalDays: allRecords.length,
        present: presentCount,
        absent: absentCount,
        rate:
          allRecords.length > 0
            ? Math.round((presentCount / allRecords.length) * 100)
            : 0,
      },
      data: records,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ═══════════════════════════════════════════════════════════
  // GET ALL STATS — summary for all instructors
  // ═══════════════════════════════════════════════════════════
  async getAllStats() {
    const instructors = await this.prisma.instructor.findMany({
      where: {
        user: { deletedAt: null, isActive: true },
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });

    const stats = [];
    for (const inst of instructors) {
      const records = await this.prisma.instructorAttendance.findMany({
        where: { instructorId: inst.id },
      });
      const presentCount = records.filter((r) => r.present).length;
      const absentCount = records.filter((r) => !r.present).length;

      stats.push({
        instructorId: inst.id,
        fullName: inst.fullName,
        totalDays: records.length,
        present: presentCount,
        absent: absentCount,
        rate:
          records.length > 0
            ? Math.round((presentCount / records.length) * 100)
            : 0,
      });
    }

    return { data: stats };
  }
}
