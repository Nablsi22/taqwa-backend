import { Module } from '@nestjs/common';
import { InstructorAttendanceController } from './instructor-attendance.controller';
import { InstructorAttendanceService } from './instructor-attendance.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [InstructorAttendanceController],
  providers: [InstructorAttendanceService],
  exports: [InstructorAttendanceService],
})
export class InstructorAttendanceModule {}
