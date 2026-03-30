import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import * as bcrypt from 'bcrypt';

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

    // Create a User account for the student
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
  }) {
    const { search, instructorId, page = 1, limit = 20 } = params || {};
    const skip = (page - 1) * limit;

    const where: any = { deletedAt: null };

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

    const [students, total] = await Promise.all([
      this.prisma.student.findMany({
        where,
        skip,
        take: limit,
        orderBy: { fullName: 'asc' },
        include: {
          user: { select: { username: true } },
          instructor: {
            include: { user: { select: { username: true } } },
          },
          _count: { select: { attendance: true, pointsLog: true } },
        },
      }),
      this.prisma.student.count({ where }),
    ]);

    // Calculate total points for each student
    const studentsWithPoints = await Promise.all(
      students.map(async (student) => {
        const pointsAgg = await this.prisma.pointsLog.aggregate({
          where: { studentId: student.id },
          _sum: { amount: true },
        });
        return {
          ...student,
          totalPoints: pointsAgg._sum.amount || 0,
        };
      }),
    );

    return {
      data: studentsWithPoints,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
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

    // Calculate total points
    const totalPoints = student.pointsLog.reduce((sum: number, p) => {
      return p.category.type === 'EARN'
        ? sum + p.amount
        : sum - p.amount;
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

    // Handle password reset
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
    // Soft delete
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