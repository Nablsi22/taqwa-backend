import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { ClientIpThrottlerGuard } from './common/client-ip-throttler.guard';
import { InstructorsModule } from './instructors/instructors.module';
import { AuthModule } from './auth/auth.module';
import { StudentsModule } from './students/students.module';
import { AttendanceModule } from './attendance/attendance.module';
import { PointsModule } from './points/points.module';
//import { QuranModule } from './quran/quran.module';
import { AnnouncementModule } from './announcement/announcement.module';
import { GiftsModule } from './gifts/gifts.module';
import { PointRulesModule } from './point-rules/point-rules.module';
import { RecitationModule } from './recitation/recitation.module';
import { NotificationModule } from './notification/notification.module';
import { InstructorAttendanceModule } from './instructor-attendance/instructor-attendance.module';
import { TermsModule } from './terms/terms.module';
import { AttendanceStatsModule } from './attendance-stats/attendance-stats.module';
import { SubstituteModule } from './substitute/substitute.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { ScheduledNotificationsModule } from './scheduled-notifications/scheduled-notifications.module';
import { QuranPagesModule } from './quran-pages/quran-pages.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Per caller (ClientIpThrottlerGuard), not per Railway proxy: 300
    // requests a minute is far above what one phone does, and still stops
    // a script. Sign-in has its own, tighter limit (auth.controller.ts).
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      errorMessage: 'طلبات كثيرة خلال وقت قصير. انتظر دقيقة ثم أعد المحاولة.',
    }),
    // The evening notifications' clock (scheduled-notifications.jobs.ts).
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    StudentsModule,
    InstructorsModule,
    AttendanceModule,
    PointsModule,
    //QuranModule,
    AnnouncementModule,
    GiftsModule,
    PointRulesModule,
    RecitationModule,
    NotificationModule,
    InstructorAttendanceModule,
    TermsModule,
    AttendanceStatsModule,
    SubstituteModule,
    SupervisorModule,
    ScheduledNotificationsModule,
    // Mushaf page images for the web app (same origin; see the module).
    QuranPagesModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ClientIpThrottlerGuard,
    },
  ],
})
export class AppModule {}
