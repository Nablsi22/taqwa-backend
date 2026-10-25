import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PointRulesModule } from '../point-rules/point-rules.module';
import { TermsModule } from '../terms/terms.module';

@Module({
  imports: [PrismaModule, PointRulesModule, TermsModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
