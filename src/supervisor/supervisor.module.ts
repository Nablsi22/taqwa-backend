import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendanceStatsModule } from '../attendance-stats/attendance-stats.module';
import { RecitationModule } from '../recitation/recitation.module';
import { SupervisorController } from './supervisor.controller';
import { SupervisorService } from './supervisor.service';
import { SupervisorDetailService } from './supervisor-detail.service';

@Module({
  imports: [PrismaModule, AttendanceStatsModule, RecitationModule],
  controllers: [SupervisorController],
  providers: [SupervisorService, SupervisorDetailService],
  // exported for the 11 pm director summary, which reports the same facts.
  exports: [SupervisorService],
})
export class SupervisorModule {}
