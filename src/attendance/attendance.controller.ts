import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AttendanceService } from './attendance.service';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // POST /api/v1/attendance/mark — mark attendance for multiple students
  @Post('mark')
  @Roles('ADMIN', 'INSTRUCTOR')
  mark(@Body() dto: MarkAttendanceDto, @Request() req: any) {
  return this.attendanceService.markAttendance(dto, req.user.id);  }

  // GET /api/v1/attendance/sheet?date=2026-03-05&instructorId=xxx
  @Get('sheet')
  @Roles('ADMIN', 'INSTRUCTOR')
  getSheet(
    @Query('date') date: string,
    @Query('instructorId') instructorId?: string,
  ) {
    return this.attendanceService.getAttendanceSheet(date, instructorId);
  }

  // GET /api/v1/attendance/by-date?date=2026-03-05
  @Get('by-date')
  @Roles('ADMIN', 'INSTRUCTOR')
  getByDate(
    @Query('date') date: string,
    @Query('instructorId') instructorId?: string,
  ) {
    return this.attendanceService.getByDate(date, instructorId);
  }

  // GET /api/v1/attendance/student/:studentId
  @Get('student/:studentId')
  @Roles('ADMIN', 'INSTRUCTOR', 'STUDENT')
  getStudentHistory(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('month') month?: string,
  ) {
    return this.attendanceService.getStudentHistory(studentId, {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 30,
      month,
    });
  }

  // GET /api/v1/attendance/stats?date=2026-03-05
  @Get('stats')
  @Roles('ADMIN', 'INSTRUCTOR')
  getDayStats(@Query('date') date: string) {
    return this.attendanceService.getDayStats(date);
  }
}