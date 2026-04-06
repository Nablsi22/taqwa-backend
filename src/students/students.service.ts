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

@Injectable()
export class StudentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateStudentDto, createdByUserId: string) {
    const instructor = await this.prisma.instructor.findUnique({
      where: { id: dto.instructorId },
    });
    if (!instructor) {
      throw new BadRequestException('المعلم غير موجود');
    }

    const username =
      dto.username || dto.fullName.replace(/\s+/g, '.').toLowerCase();
    const password = dto.password || 'Taqwa@2026';
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        role: 'STUDENT',
        isActive: true,
      },
    });

    return this.prisma.student.create({
      data: {
        userId: user.id,
        fullName: dto.fullName,
        fatherName: dto.fatherName,
        dateOfBirth: new Date(dto.dateOfBirth),
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

  async resetPassword(id: string, password: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { userId: true, fullName: true },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await this.prisma.user.update({
      where: { id: student.userId },
      data: { passwordHash },
    });
    return { message: 'تم تغيير كلمة المرور بنجاح' };
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
}