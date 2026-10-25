import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendanceStatsModule } from '../attendance-stats/attendance-stats.module';
import { ScheduledNotificationsController } from './scheduled-notifications.controller';
import { ScheduledNotificationsJobs } from './scheduled-notifications.jobs';
import { ScheduledNotificationsService } from './scheduled-notifications.service';

/**
 * Phase 4 — the evening notifications. FirebaseService comes from the global
 * NotificationModule; ScheduleModule.forRoot() is registered once in AppModule.
 */
@Module({
  imports: [PrismaModule, AttendanceStatsModule],
  controllers: [ScheduledNotificationsController],
  providers: [ScheduledNotificationsService, ScheduledNotificationsJobs],
})
export class ScheduledNotificationsModule {}
