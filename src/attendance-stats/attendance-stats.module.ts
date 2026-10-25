import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendanceStatsController } from './attendance-stats.controller';
import { AttendanceStatsService } from './attendance-stats.service';

@Module({
  imports: [PrismaModule],
  controllers: [AttendanceStatsController],
  providers: [AttendanceStatsService],
  // exported for the course-director dashboard and the notification jobs
  exports: [AttendanceStatsService],
})
export class AttendanceStatsModule {}
