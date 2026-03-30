import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInstructorDto } from './dto/create-instructor.dto';
import { UpdateInstructorDto } from './dto/update-instructor.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class InstructorsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List all instructors with student count and optional search
   */
  async findAll(params?: { search?: string; page?: number; limit?: number }) {
    const { search, page = 1, limit = 20 } = params || {};
    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { mobile: { contains: search, mode: 'insensitive' } },
        { user: { username: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [instructors, total] = await Promise.all([
      this.prisma.instructor.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          dateOfBirth: true,
          specialty: true,
          address: true,
          mobile: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              username: true,
            },
          },
          _count: {
            select: {
              students: true,
            },
          },
        },
        orderBy: { fullName: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.instructor.count({ where }),
    ]);

    return {
      data: instructors.map((inst) => ({
        id: inst.id,
        userId: inst.user.id,
        username: inst.user.username,
        fullName: inst.fullName,
        dateOfBirth: inst.dateOfBirth,
        specialty: inst.specialty,
        address: inst.address,
        mobile: inst.mobile,
        studentCount: inst._count.students,
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
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
   * Get single instructor by ID with full details and student list
   */
  async findOne(id: string) {
    const instructor = await this.prisma.instructor.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        dateOfBirth: true,
        specialty: true,
        address: true,
        mobile: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            username: true,
          },
        },
        students: {
          where: { deletedAt: null },
          select: {
            id: true,
            fullName: true,
            phone1: true,
          },
          orderBy: { fullName: 'asc' },
        },
        _count: {
          select: {
            students: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!instructor) {
      throw new NotFoundException('المعلم غير موجود');
    }

    return {
      id: instructor.id,
      userId: instructor.user.id,
      username: instructor.user.username,
      fullName: instructor.fullName,
      dateOfBirth: instructor.dateOfBirth,
      specialty: instructor.specialty,
      address: instructor.address,
      mobile: instructor.mobile,
      studentCount: instructor._count.students,
      students: instructor.students,
      createdAt: instructor.createdAt,
      updatedAt: instructor.updatedAt,
    };
  }

  /**
   * Create a new instructor — creates User + Instructor records
   */
  async create(dto: CreateInstructorDto) {
    // Check if username already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    if (existingUser) {
      throw new ConflictException('اسم المستخدم مستخدم بالفعل');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(dto.password, 12);

    // Create User + Instructor in a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username: dto.username,
          passwordHash: hashedPassword,
          role: 'INSTRUCTOR',
        },
      });

      const instructor = await tx.instructor.create({
        data: {
          userId: user.id,
          fullName: dto.fullName,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          specialty: dto.specialty || null,
          address: dto.address || null,
          mobile: dto.mobile || null,
        },
        select: {
          id: true,
          fullName: true,
          dateOfBirth: true,
          specialty: true,
          mobile: true,
          createdAt: true,
        },
      });

      return {
        ...instructor,
        username: user.username,
        userId: user.id,
      };
    });

    return {
      message: 'تم إضافة المعلم بنجاح',
      data: result,
    };
  }

  /**
   * Update instructor details
   */
  async update(id: string, dto: UpdateInstructorDto) {
    // Verify instructor exists
    const existing = await this.prisma.instructor.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!existing) {
      throw new NotFoundException('المعلم غير موجود');
    }

    // If username is being changed, check for duplicates
    if (dto.username && dto.username !== existing.user.username) {
      const duplicate = await this.prisma.user.findUnique({
        where: { username: dto.username },
      });
      if (duplicate) {
        throw new ConflictException('اسم المستخدم مستخدم بالفعل');
      }
    }

    // Update in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Update User if needed
      const userData: any = {};
      if (dto.username) userData.username = dto.username;
      if (dto.password) {
        userData.passwordHash = await bcrypt.hash(dto.password, 12);
      }
      if (Object.keys(userData).length > 0) {
        await tx.user.update({
          where: { id: existing.userId },
          data: userData,
        });
      }

      // Update Instructor
      const instructorData: any = {};
      if (dto.fullName) instructorData.fullName = dto.fullName;
      if (dto.dateOfBirth !== undefined) instructorData.dateOfBirth = dto.dateOfBirth || null;
      if (dto.specialty !== undefined) instructorData.specialty = dto.specialty || null;
      if (dto.address !== undefined) instructorData.address = dto.address || null;
      if (dto.mobile !== undefined) instructorData.mobile = dto.mobile || null;

      const updated = await tx.instructor.update({
        where: { id },
        data: instructorData,
        select: {
          id: true,
          fullName: true,
          dateOfBirth: true,
          specialty: true,
          address: true,
          mobile: true,
          updatedAt: true,
          user: {
            select: { username: true },
          },
        },
      });

      return updated;
    });

    return {
      message: 'تم تحديث بيانات المعلم بنجاح',
      data: {
        id: result.id,
        username: result.user.username,
        fullName: result.fullName,
        dateOfBirth: result.dateOfBirth,
        specialty: result.specialty,
        address: result.address,
        mobile: result.mobile,
        updatedAt: result.updatedAt,
      },
    };
  }

  /**
   * Delete instructor — only if they have no active students
   */
  async remove(id: string) {
    const instructor = await this.prisma.instructor.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            students: { where: { deletedAt: null } },
          },
        },
      },
    });

    if (!instructor) {
      throw new NotFoundException('المعلم غير موجود');
    }

    if (instructor._count.students > 0) {
      throw new BadRequestException(
        `لا يمكن حذف المعلم لأن لديه ${instructor._count.students} طالب. قم بنقل الطلاب أولاً`,
      );
    }

    // Delete both Instructor and User in transaction
    await this.prisma.$transaction(async (tx) => {
      await tx.instructor.delete({ where: { id } });
      await tx.user.delete({ where: { id: instructor.userId } });
    });

    return {
      message: 'تم حذف المعلم بنجاح',
    };
  }

  /**
   * Reset instructor password (admin action)
   */
  async resetPassword(id: string, newPassword: string) {
    const instructor = await this.prisma.instructor.findUnique({
      where: { id },
    });

    if (!instructor) {
      throw new NotFoundException('المعلم غير موجود');
    }

    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({
      where: { id: instructor.userId },
      data: { passwordHash: hashedPassword },
    });

    return {
      message: 'تم إعادة تعيين كلمة المرور بنجاح',
    };
  }
}