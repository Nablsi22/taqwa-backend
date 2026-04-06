import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  generateCredentials,
  generateNewPassword,
  generatePassword,
  hashPassword,
} from './credentials.util';

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateStudentDto, createdByUserId: string) {
    // Verify instructor exists
    const instructor = await this.prisma.instructor.findUnique({
      where: { id: dto.instructorId },
    });
    if (!instructor) {
      throw new BadRequestException('المعلم غير موجود');
    }

    const dob = new Date(dto.dateOfBirth);

    // Auto-generate username (YYYYNNNN) and a strong random password.
    // The plain password is returned to the caller ONCE so the admin
    // can distribute it; it is never stored anywhere except as a bcrypt hash.
    const { username, plainPassword, passwordHash } =
      await generateCredentials(this.prisma, dob);

    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        role: 'STUDENT',
        isActive: true,
      },
    });

    const student = await this.prisma.student.create({
      data: {
        userId: user.id,
        fullName: dto.fullName,
        fatherName: dto.fatherName,
        dateOfBirth: dob,
        instructorId: dto.instructorId,
        school: dto.school,
        address: dto.address,
        phone1: dto.phone1,
        phone2: dto.phone2,
        grade: dto.grade || null,
      },
      include: {
        instructor: {
          include: { user: { select: { username: true } } },
        },
        _count: { select: { attendance: true, pointsLog: true } },
      },
    });

    // ⚠️ The plain password is returned ONCE in this response.
    // The Flutter app must show it to the admin immediately and never
    // request it again — there's no endpoint to retrieve it later.
    return {
      ...student,
      generatedCredentials: {
        username,
        password: plainPassword,
      },
    };
  }

  async findAll(params?: {
    search?: string;
    instructorId?: string;
    page?: number;
    limit?: number;
    all?: boolean;
  }) {
    const { search, instructorId, all = false } = params || {};
    const page = Math.max(1, params?.page ?? 1);
    // Raised default from 20 → 50. Hard cap at 500 to protect the server.
    const limit = Math.min(500, Math.max(1, params?.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.StudentWhereInput = { deletedAt: null };

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { fatherName: { contains: search, mode: 'insensitive' } },
        { phone1: { contains: search } },
        { phone2: { contains: search } },
      ];
    }

    if (instructorId) {
      where.instructorId = instructorId;
    }

    // When `all=true` the client explicitly opts out of pagination.
    // Still cap at 2000 to avoid accidental OOM.
    const findManyArgs: Prisma.StudentFindManyArgs = {
      where,
      orderBy: { fullName: 'asc' },
      include: {
        user: { select: { username: true } },
        instructor: {
          include: { user: { select: { username: true } } },
        },
        _count: { select: { attendance: true, pointsLog: true } },
      },
      ...(all ? { take: 2000 } : { skip, take: limit }),
    };

    const [students, total] = await Promise.all([
      this.prisma.student.findMany(findManyArgs),
      this.prisma.student.count({ where }),
    ]);

    // --- Performance fix: single aggregated query instead of N+1 ---
    // Previous code ran one aggregate() per student. For 100 students
    // that was 100 extra round-trips. We now fetch all sums in one
    // groupBy, split by category type so EARN and SPEND can be netted
    // the same way findOne() does it.
    const studentIds = students.map((s) => s.id);

    const pointsGrouped = studentIds.length
      ? await this.prisma.pointsLog.groupBy({
          by: ['studentId', 'categoryId'],
          where: { studentId: { in: studentIds } },
          _sum: { amount: true },
        })
      : [];

    // We also need each category's type (EARN/SPEND) to net correctly.
    const categoryIds = [
      ...new Set(pointsGrouped.map((g) => g.categoryId)),
    ];
    const categories = categoryIds.length
      ? await this.prisma.pointCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, type: true },
        })
      : [];
    const categoryTypeById = new Map(
      categories.map((c) => [c.id, c.type]),
    );

    const totalsByStudent = new Map<string, number>();
    for (const row of pointsGrouped) {
      const amount = row._sum.amount ?? 0;
      const type = categoryTypeById.get(row.categoryId);
      const signed = type === 'DEDUCT' ? -amount : amount;
      totalsByStudent.set(
        row.studentId,
        (totalsByStudent.get(row.studentId) ?? 0) + signed,
      );
    }

    const studentsWithPoints = students.map((student) => ({
      ...student,
      totalPoints: totalsByStudent.get(student.id) ?? 0,
    }));

    return {
      data: studentsWithPoints,
      meta: {
        total,
        page: all ? 1 : page,
        limit: all ? total : limit,
        totalPages: all ? 1 : Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: {
        user: { select: { username: true } },
        instructor: {
          include: { user: { select: { username: true } } },
        },
        attendance: {
          orderBy: { date: 'desc' },
          take: 30,
        },
        pointsLog: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { category: true },
        },
        _count: { select: { attendance: true, pointsLog: true } },
      },
    });

    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const totalPoints = student.pointsLog.reduce((sum: number, p) => {
      return p.category.type === 'EARN' ? sum + p.amount : sum - p.amount;
    }, 0);

    return { ...student, totalPoints };
  }

  async update(id: string, dto: UpdateStudentDto) {
    const exists = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('الطالب غير موجود');
    }

    if (dto.instructorId) {
      const instructor = await this.prisma.instructor.findUnique({
        where: { id: dto.instructorId },
      });
      if (!instructor) {
        throw new BadRequestException('المعلم غير موجود');
      }
    }

    if (dto.password) {
      const student = await this.prisma.student.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (student) {
        const passwordHash = await bcrypt.hash(dto.password, 12);
        await this.prisma.user.update({
          where: { id: student.userId },
          data: { passwordHash },
        });
      }
    }

    return this.prisma.student.update({
      where: { id },
      data: {
        ...(dto.fullName && { fullName: dto.fullName }),
        ...(dto.fatherName && { fatherName: dto.fatherName }),
        ...(dto.dateOfBirth && { dateOfBirth: new Date(dto.dateOfBirth) }),
        ...(dto.instructorId && { instructorId: dto.instructorId }),
        ...(dto.school !== undefined && { school: dto.school }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.phone1 !== undefined && { phone1: dto.phone1 }),
        ...(dto.phone2 !== undefined && { phone2: dto.phone2 }),
        ...(dto.grade !== undefined && { grade: dto.grade }),
      },
      include: {
        instructor: {
          include: { user: { select: { username: true } } },
        },
      },
    });
  }

  async resetPassword(id: string, _ignoredManualPassword?: string) {
    // Note: the second parameter used to be a manually-provided password.
    // We now ignore it and always generate a strong random one for security.
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { userId: true, fullName: true },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const { plainPassword, passwordHash } = await generateNewPassword();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: student.userId },
        data: { passwordHash },
      }),
      this.prisma.student.update({
        where: { id },
        data: { lastCredentialReset: new Date() },
      }),
    ]);

    // Plain password returned ONCE — same security model as create().
    return {
      message: 'تم إنشاء كلمة مرور جديدة',
      newPassword: plainPassword,
      studentName: student.fullName,
    };
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.student.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async getStudentStats(id: string) {
    const student = await this.findOne(id);

    const attendanceCount = await this.prisma.attendance.groupBy({
      by: ['status'],
      where: { studentId: id },
      _count: true,
    });

    const pointsByCategory = await this.prisma.pointsLog.groupBy({
      by: ['categoryId'],
      where: { studentId: id },
      _sum: { amount: true },
    });

    return {
      studentId: id,
      fullName: student.fullName,
      totalPoints: student.totalPoints,
      attendance: attendanceCount,
      pointsByCategory,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CREDENTIALS MANAGEMENT — admin-only
  // ═══════════════════════════════════════════════════════════════

  /**
   * List every student with credential metadata for the admin
   * credentials screen. Does NOT return passwords (we don't have them).
   */
  async listCredentials(params?: {
    search?: string;
    sentFilter?: 'all' | 'sent' | 'unsent';
  }) {
    const { search, sentFilter = 'all' } = params || {};

    const where: any = { deletedAt: null };

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { phone1: { contains: search } },
        { phone2: { contains: search } },
        { user: { username: { contains: search } } },
      ];
    }

    if (sentFilter === 'sent') {
      where.credentialsSentAt = { not: null };
    } else if (sentFilter === 'unsent') {
      where.credentialsSentAt = null;
    }

    const students = await this.prisma.student.findMany({
      where,
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        phone1: true,
        phone2: true,
        credentialsSentAt: true,
        lastCredentialReset: true,
        instructor: { select: { fullName: true } },
        user: { select: { username: true } },
      },
    });

    return {
      data: students.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        username: s.user.username,
        phone1: s.phone1,
        phone2: s.phone2,
        instructorName: s.instructor.fullName,
        credentialsSentAt: s.credentialsSentAt,
        lastCredentialReset: s.lastCredentialReset,
      })),
      meta: {
        total: students.length,
        sent: students.filter((s) => s.credentialsSentAt != null).length,
        unsent: students.filter((s) => s.credentialsSentAt == null).length,
      },
    };
  }

  /**
   * Mark a student's credentials as having been sent to the parent.
   * Called by Flutter after the admin confirms the WhatsApp send.
   */
  async markCredentialsSent(id: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    await this.prisma.student.update({
      where: { id },
      data: { credentialsSentAt: new Date() },
    });

    return { message: 'تم تسجيل إرسال البيانات' };
  }

  /**
   * One-time bulk regeneration of every student's credentials.
   * This is the migration helper for moving from the old manual scheme
   * to the new YYYYNNNN system. Returns ALL plain passwords ONCE so the
   * caller can immediately save them to an Excel file. After this call
   * returns, the passwords are gone forever.
   *
   * Idempotency safety: this endpoint is dangerous. The controller
   * requires a confirmation token in the request body to prevent
   * accidental invocation.
   */
 async regenerateAllCredentials(): Promise<{
    message: string;
    count: number;
    credentials: Array<{
      studentId: string;
      fullName: string;
      username: string;
      password: string;
      phone1: string | null;
      phone2: string | null;
      instructorName: string;
    }>;
  }> {
    const students = await this.prisma.student.findMany({
      where: { deletedAt: null },
      orderBy: [{ dateOfBirth: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: true,
        instructor: { select: { fullName: true } },
      },
    });

    if (students.length === 0) {
      return { message: 'لا يوجد طلاب', count: 0, credentials: [] };
    }

    // ─── PHASE 1: Park all student usernames in a temporary unique
    // namespace to avoid ANY collision when assigning new ones.
    // We use the user's UUID (always unique) prefixed with "tmp_".
    // ─────────────────────────────────────────────────────────────
    try {
      await this.prisma.$transaction(
        students.map((s) =>
          this.prisma.user.update({
            where: { id: s.userId },
            data: { username: `tmp_${s.userId}` },
          }),
        ),
      );
    } catch (err: any) {
      console.error('[regenerateAll] phase 1 (parking) failed:', err);
      throw new BadRequestException(
        `فشل المرحلة الأولى من التحديث: ${err?.message || err}`,
      );
    }

    // ─── PHASE 2: Assign final YYYYNNNN usernames + new passwords ───
    const results: Array<{
      studentId: string;
      fullName: string;
      username: string;
      password: string;
      phone1: string | null;
      phone2: string | null;
      instructorName: string;
    }> = [];

    const yearCounters = new Map<number, number>();

    for (const student of students) {
      try {
        const year = student.dateOfBirth.getFullYear();
        const next = (yearCounters.get(year) ?? 0) + 1;
        yearCounters.set(year, next);

        const username = `${year}${next.toString().padStart(4, '0')}`;
        const plainPassword = generatePassword();
        const passwordHash = await hashPassword(plainPassword);

        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: student.userId },
            data: { username, passwordHash },
          }),
          this.prisma.student.update({
            where: { id: student.id },
            data: {
              lastCredentialReset: new Date(),
              credentialsSentAt: null,
            },
          }),
        ]);

        results.push({
          studentId: student.id,
          fullName: student.fullName,
          username,
          password: plainPassword,
          phone1: student.phone1,
          phone2: student.phone2,
          instructorName: student.instructor.fullName,
        });
      } catch (err: any) {
        console.error(
          `[regenerateAll] failed for student ${student.id} (${student.fullName}):`,
          err,
        );
        throw new BadRequestException(
          `فشل تحديث الطالب ${student.fullName}: ${err?.message || err}`,
        );
      }
    }

    return {
      message: `تم إنشاء بيانات دخول جديدة لـ ${results.length} طالب`,
      count: results.length,
      credentials: results,
    };
  }
}