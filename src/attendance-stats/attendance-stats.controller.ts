import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AttendanceStatsService } from './attendance-stats.service';
import {
  CalendarQueryDto,
  CourseQueryDto,
  DayQueryDto,
  StudentsQueryDto,
} from './dto/attendance-stats-query.dto';
import { ATTENDANCE_RULES } from './attendance-stats.rules';
import { isCalendarDay, localToday } from './meeting-days';

/**
 * Read-only attendance statistics. Nothing under this route writes.
 *
 * Instructors only ever see their own حلقة on the aggregate routes; the
 * per-student routes stay open to them like GET /students/:id already is,
 * because a substitute instructor works with students of other حلقات.
 */
@Controller('api/v1/attendance-stats')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceStatsController {
  constructor(private readonly stats: AttendanceStatsService) {}

  // GET /api/v1/attendance-stats/overview?termId=
  @Get('overview')
  @Roles('ADMIN')
  overview(@Query() q: CourseQueryDto) {
    return this.stats.overview(q.termId);
  }

  // GET /api/v1/attendance-stats/students?termId=&instructorId=
  @Get('students')
  @Roles('ADMIN', 'INSTRUCTOR')
  async students(
    @Query() q: StudentsQueryDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    const instructorId = await this.stats.scopeInstructor(
      { userId: req.user.id, role: req.user.role },
      q.instructorId,
    );
    const ctx = await this.stats.courseContext(q.termId);
    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      windowStart: ctx.windowStart,
      measuredUntil: ctx.measuredUntil,
      data: await this.stats.studentStats(ctx, { instructorId }),
    };
  }

  // GET /api/v1/attendance-stats/day?date=&termId=&instructorId=
  @Get('day')
  @Roles('ADMIN', 'INSTRUCTOR')
  async day(
    @Query() q: DayQueryDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    const instructorId = await this.stats.scopeInstructor(
      { userId: req.user.id, role: req.user.role },
      q.instructorId,
    );
    const ctx = await this.stats.courseContext(q.termId);
    const date = q.date ?? ctx.lastRequired.withRecords;
    if (!date) {
      return {
        course: ctx.term,
        date: null,
        kind: null,
        halaqas: [],
        message: 'لا توجد جلسة مسجّلة في هذه الدورة بعد',
      };
    }
    if (!isCalendarDay(date)) throw new BadRequestException('تاريخ غير صالح');
    this.stats.assertDayInCourse(ctx, date);
    return {
      course: ctx.term,
      ...(await this.stats.day(ctx, date, instructorId)),
    };
  }

  // GET /api/v1/attendance-stats/student/:id?termId=
  @Get('student/:id')
  @Roles('ADMIN', 'INSTRUCTOR', 'SUPERVISOR')
  async student(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CourseQueryDto,
  ) {
    const ctx = await this.stats.courseContext(q.termId);
    const [row] = await this.stats.studentStats(ctx, { studentId: id });
    if (!row)
      throw new NotFoundException('الطالب غير موجود ضمن طلاب الدورة الحاليين');
    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      windowStart: ctx.windowStart,
      data: row,
    };
  }

  // GET /api/v1/attendance-stats/student/:id/calendar?month=YYYY-MM
  @Get('student/:id/calendar')
  @Roles('ADMIN', 'INSTRUCTOR', 'SUPERVISOR')
  calendar(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CalendarQueryDto,
  ) {
    const month =
      q.month ?? localToday(ATTENDANCE_RULES.localTimeZone).slice(0, 7);
    return this.stats.studentCalendar(id, month);
  }
}
