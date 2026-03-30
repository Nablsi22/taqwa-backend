import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

@Injectable()
export class AnnouncementService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CREATE — Admin or Instructor + Send Push Notification
  // ═══════════════════════════════════════════════════════════════════════════
  async create(dto: CreateAnnouncementDto, userId: string) {
    const announcement = await this.prisma.announcement.create({
      data: {
        title: dto.title,
        body: dto.body,
        pinned: dto.pinned ?? false,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdBy: userId,
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            role: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
    });

    // ── Send Push Notification ──
    try {
      const authorRole = announcement.author?.role;

      if (authorRole === 'INSTRUCTOR') {
        // Instructor announcement → notify only their students
        await this.notificationService.notifyInstructorStudents(
          userId,
          announcement.title,
          announcement.body,
          { type: 'announcement', id: announcement.id },
        );
      } else {
        // Admin announcement → notify ALL users (students + instructors)
        await this.notificationService.notifyAll(
          announcement.title,
          announcement.body,
          { type: 'announcement', id: announcement.id },
        );
      }
    } catch (error) {
      // Don't fail the announcement creation if notification fails
      console.error('Push notification failed:', error.message);
    }

    return announcement;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ALL — Role-based filtering (THE CORE LOGIC)
  // ═══════════════════════════════════════════════════════════════════════════
  async findAll(userId: string, userRole: string) {
    const baseWhere: any = {
      OR: [
        { expiresAt: null },
        { expiresAt: { gte: new Date() } },
      ],
    };

    let createdByFilter: any[];

    if (userRole === 'ADMIN') {
      createdByFilter = [{}];
    } else if (userRole === 'INSTRUCTOR') {
      createdByFilter = [
        { author: { role: 'ADMIN' } },
        { createdBy: userId },
      ];
    } else {
      const student = await this.prisma.student.findFirst({
        where: { userId },
        select: { instructor: { select: { userId: true } } },
      });

      createdByFilter = [
        { author: { role: 'ADMIN' } },
      ];

      if (student?.instructor?.userId) {
        createdByFilter.push({
          createdBy: student.instructor.userId,
        });
      }
    }

    return this.prisma.announcement.findMany({
      where: {
        AND: [
          baseWhere,
          { OR: createdByFilter },
        ],
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            role: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
      orderBy: [
        { pinned: 'desc' },
        { publishedAt: 'desc' },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND ONE
  // ═══════════════════════════════════════════════════════════════════════════
  async findOne(id: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            role: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
    });

    if (!announcement) {
      throw new NotFoundException('الإعلان غير موجود');
    }

    return announcement;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UPDATE
  // ═══════════════════════════════════════════════════════════════════════════
  async update(id: string, dto: UpdateAnnouncementDto, userId: string, userRole: string) {
    const announcement = await this.findOne(id);

    if (userRole !== 'ADMIN' && announcement.createdBy !== userId) {
      throw new ForbiddenException('لا يمكنك تعديل إعلان لم تقم بإنشائه');
    }

    return this.prisma.announcement.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.body !== undefined && { body: dto.body }),
        ...(dto.pinned !== undefined && { pinned: dto.pinned }),
        ...(dto.expiresAt !== undefined && {
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        }),
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            role: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════════════
  async remove(id: string, userId: string, userRole: string) {
    const announcement = await this.findOne(id);

    if (userRole !== 'ADMIN' && announcement.createdBy !== userId) {
      throw new ForbiddenException('لا يمكنك حذف إعلان لم تقم بإنشائه');
    }

    return this.prisma.announcement.delete({ where: { id } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOGGLE PIN
  // ═══════════════════════════════════════════════════════════════════════════
  async togglePin(id: string) {
    const announcement = await this.findOne(id);
    return this.prisma.announcement.update({
      where: { id },
      data: { pinned: !announcement.pinned },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            role: true,
            instructor: { select: { fullName: true } },
          },
        },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════════════════════════
  async getStats() {
    const [total, pinned, active] = await Promise.all([
      this.prisma.announcement.count(),
      this.prisma.announcement.count({ where: { pinned: true } }),
      this.prisma.announcement.count({
        where: {
          OR: [
            { expiresAt: null },
            { expiresAt: { gte: new Date() } },
          ],
        },
      }),
    ]);

    return { total, pinned, active };
  }
}