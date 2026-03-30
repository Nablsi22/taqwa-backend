import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FirebaseService } from './firebase.service';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private prisma: PrismaService,
    private firebaseService: FirebaseService,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // TOKEN MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Register or update FCM token for a user
   */
  async registerToken(userId: string, token: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: token },
    });
    this.logger.log(`FCM token registered for user: ${userId}`);
    return { success: true };
  }

  /**
   * Remove FCM token (on logout)
   */
  async removeToken(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { fcmToken: null },
    });
    return { success: true };
  }

  /**
   * Clean up invalid tokens
   */
  private async cleanInvalidTokens(invalidTokens: string[]) {
    if (invalidTokens.length === 0) return;

    for (const token of invalidTokens) {
      await this.prisma.user.updateMany({
        where: { fcmToken: token },
        data: { fcmToken: null },
      });
    }
    this.logger.log(`Cleaned ${invalidTokens.length} invalid FCM tokens`);
  }

  // ═══════════════════════════════════════════════════════════
  // SEND NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════

  /**
   * Send notification to ALL users (admin announcement)
   */
  async notifyAll(title: string, body: string, data?: Record<string, string>) {
    const users = await this.prisma.user.findMany({
      where: {
        fcmToken: { not: null },
        isActive: true,
      },
      select: { fcmToken: true },
    });

    const tokens = users
      .map((u) => u.fcmToken)
      .filter((t): t is string => t !== null && t.length > 0);

    if (tokens.length === 0) {
      this.logger.warn('No FCM tokens found — no notifications sent');
      return { sent: 0, total: 0 };
    }

    const result = await this.firebaseService.sendToMultipleDevices(
      tokens,
      title,
      body,
      data,
    );

    await this.cleanInvalidTokens(result.invalidTokens);

    return {
      sent: result.success,
      failed: result.failure,
      total: tokens.length,
    };
  }

  /**
   * Send notification to a specific instructor's students only
   */
  async notifyInstructorStudents(
    instructorId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    // Find the instructor's ID in the Instructor table
    // instructorId might be the User ID, so resolve it
    let actualInstructorId = instructorId;
    const instructor = await this.prisma.instructor.findFirst({
      where: { userId: instructorId },
    });
    if (instructor) {
      actualInstructorId = instructor.id;
    }

    // Get all students assigned to this instructor
    const students = await this.prisma.student.findMany({
      where: { instructorId: actualInstructorId },
      include: { user: { select: { fcmToken: true } } },
    });

    const tokens = students
      .map((s) => s.user?.fcmToken)
      .filter((t): t is string => t !== null && t.length > 0);

    if (tokens.length === 0) {
      this.logger.warn(
        `No FCM tokens for instructor ${actualInstructorId}'s students`,
      );
      return { sent: 0, total: 0 };
    }

    const result = await this.firebaseService.sendToMultipleDevices(
      tokens,
      title,
      body,
      data,
    );

    await this.cleanInvalidTokens(result.invalidTokens);

    return {
      sent: result.success,
      failed: result.failure,
      total: tokens.length,
    };
  }

  /**
   * Send notification to a single user
   */
  async notifyUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fcmToken: true },
    });

    if (!user?.fcmToken) return { sent: false };

    const success = await this.firebaseService.sendToDevice(
      user.fcmToken,
      title,
      body,
      data,
    );

    if (!success) {
      await this.cleanInvalidTokens([user.fcmToken]);
    }

    return { sent: success };
  }

  /**
   * Send notification to all instructors
   */
  async notifyAllInstructors(
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const instructors = await this.prisma.user.findMany({
      where: {
        role: 'INSTRUCTOR',
        fcmToken: { not: null },
        isActive: true,
      },
      select: { fcmToken: true },
    });

    const tokens = instructors
      .map((u) => u.fcmToken)
      .filter((t): t is string => t !== null && t.length > 0);

    if (tokens.length === 0) return { sent: 0, total: 0 };

    const result = await this.firebaseService.sendToMultipleDevices(
      tokens,
      title,
      body,
      data,
    );

    await this.cleanInvalidTokens(result.invalidTokens);

    return { sent: result.success, total: tokens.length };
  }
}
