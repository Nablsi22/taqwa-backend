import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PointRulesService } from '../point-rules/point-rules.service';
import {
  MarkAttendanceDto,
  UnmarkAttendanceDto,
} from './dto/mark-attendance.dto';
import { TermsService } from '../terms/terms.service';
import { DayKind, dayKindOf, isIsoDow } from '../attendance-stats/meeting-days';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pointRulesService: PointRulesService,
    private readonly termsService: TermsService,
  ) {}

  async markAttendance(dto: MarkAttendanceDto, markedByUserId: string) {
    // Attendance points are points, so they belong to a course like any
    // other. Resolved once for the whole sheet — marking a حلقة is one act
    // and must not straddle two courses if an admin switches mid-request.
    const termId = await this.termsService.requireActiveTermId();
    const date = new Date(dto.date);
    const results: any[] = [];

    // Only a REQUIRED day of the course can cost points. On an optional day
    // (winter Thursday) or any day outside the schedule we reward whoever
    // came and deduct from nobody — "نكافئ يلي بيجي وما نخصم من يلي بيغيب".
    const dayKind = await this.dayKindInCourse(termId, dto.date);

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
      const isAbsent = (entry.status as string) === 'ABSENT';
      if (entry.excused === true && !isAbsent) {
        throw new BadRequestException('«غائب بعذر» يكون مع حالة الغياب فقط');
      }
      const student = await this.prisma.student.findUnique({
        where: { id: entry.studentId },
      });
      if (!student) {
        throw new BadRequestException(`الطالب غير موجود: ${entry.studentId}`);
      }

      const existingRecord = await this.prisma.attendance.findUnique({
        where: {
          studentId_date: {
            studentId: entry.studentId,
            date,
          },
        },
      });

      // An excuse belongs to an absence. When the field is omitted (older
      // app versions), an existing excuse on the same absence is kept.
      const excused = isAbsent
        ? (entry.excused ??
          (existingRecord?.status === 'ABSENT'
            ? existingRecord.excused
            : false))
        : false;

      const record = await this.prisma.attendance.upsert({
        where: {
          studentId_date: {
            studentId: entry.studentId,
            date,
          },
        },
        update: {
          status: entry.status,
          excused,
          notes: entry.notes,
          markedBy: markedByUserId,
        },
        create: {
          studentId: entry.studentId,
          date,
          status: entry.status,
          excused,
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
      // A correction must move the points with it. Without this the
      // attendance row changes while the original points row survives,
      // leaving the student penalised for a status they no longer have.
      // An excuse added to, or removed from, an absence is a correction too.
      const statusChanged =
        !!existingRecord &&
        (existingRecord.status !== entry.status ||
          existingRecord.excused !== excused);

      if (!existingRecord || statusChanged) {
        try {
          const rule = await this.pointRulesService.getAttendancePoints(
            entry.status as 'PRESENT' | 'LATE' | 'ABSENT',
          );
          // Reward-only: a deduction never applies on a non-required day, nor
          // to an excused absence. A positive rule always applies.
          const rewardOnly = dayKind !== 'REQUIRED' || excused;
          const ruleResult =
            rule && rewardOnly && rule.points < 0 ? null : rule;

          const categoryId = ruleResult
            ? ruleResult.points >= 0
              ? earnCategoryId
              : deductCategoryId
            : null;

          // Remove-then-write in one transaction: the student is never
          // left with two rows, nor with none because a later step threw.
          await this.prisma.$transaction(async (tx) => {
            if (statusChanged) {
              // Scoped to this attendance record alone.
              await tx.pointsLog.deleteMany({
                where: { sourceType: 'ATTENDANCE', sourceId: record.id },
              });
            }

            if (ruleResult && categoryId) {
              await tx.pointsLog.create({
                data: {
                  studentId: entry.studentId,
                  categoryId,
                  amount: ruleResult.points,
                  description: `${ruleResult.ruleNameAr} - ${dto.date}`,
                  awardedBy: markedByUserId,
                  sourceId: record.id,
                  sourceType: 'ATTENDANCE',
                  termId,
                },
              });
            }
          });
        } catch (e) {
          console.error('Auto-points failed for attendance:', e);
        }
      }

      results.push(record);
    }

    return {
      message: `تم تسجيل حضور ${results.length} طالب`,
      count: results.length,
      dayKind,
      data: results,
    };
  }

  /**
   * REQUIRED / OPTIONAL / EXTRA for `day` in the course. A course whose
   * meeting days were never configured treats every day as REQUIRED — the
   * behaviour from before meeting days existed, so nothing changes for it.
   */
  private async dayKindInCourse(termId: number, day: string): Promise<DayKind> {
    const term = await this.prisma.term.findUnique({
      where: { id: termId },
      select: { requiredDays: true, optionalDays: true },
    });
    const required = (term?.requiredDays ?? []).filter(isIsoDow);
    const optional = (term?.optionalDays ?? []).filter(isIsoDow);
    if (required.length === 0 && optional.length === 0) return 'REQUIRED';
    return dayKindOf(day.slice(0, 10), { required, optional });
  }

  // ---------------------------------------------------------------
  // UNMARK - remove an attendance record and the points it produced.
  //
  // Scoped per student per date through the studentId_date unique key,
  // so no range or bulk clause can widen the blast radius. Each pair is
  // deleted in its own transaction: the points row and the attendance
  // row always disappear together or not at all.
  //
  // Already-unmarked students are skipped rather than reported as an
  // error - the caller asked for a state, and that state already holds.
  // ---------------------------------------------------------------
  async unmarkAttendance(dto: UnmarkAttendanceDto) {
    const date = new Date(dto.date);
    let removedRecords = 0;
    let removedPoints = 0;

    for (const studentId of dto.studentIds) {
      const existing = await this.prisma.attendance.findUnique({
        where: { studentId_date: { studentId, date } },
      });
      if (!existing) continue;

      const result = await this.prisma.$transaction(async (tx) => {
        const points = await tx.pointsLog.deleteMany({
          where: { sourceType: 'ATTENDANCE', sourceId: existing.id },
        });
        await tx.attendance.delete({ where: { id: existing.id } });
        return points.count;
      });

      removedRecords += 1;
      removedPoints += result;
    }

    return {
      message: `unmarked ${removedRecords} record(s)`,
      removedRecords,
      removedPoints,
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
        excused: record?.excused ?? false,
        notes: record?.notes || null,
        isMarked: !!record,
      };
    });

    // What kind of day this is in the active course — the one the marks
    // will be recorded into — so the screen can say before saving that an
    // optional or make-up day costs nobody points. null: no active course.
    const termId = await this.termsService.getActiveTermId();
    const dayKind =
      termId == null ? null : await this.dayKindInCourse(termId, date);

    return {
      date,
      dayKind,
      // Lets the app offer «غائب بعذر» only to a server that understands it:
      // an older server rejects the unknown `excused` field outright.
      supportsExcused: true,
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
