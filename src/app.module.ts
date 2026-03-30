import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
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


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
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
    NotificationModule ,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}