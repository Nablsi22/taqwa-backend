import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SupervisorService } from './supervisor.service';
import { SupervisorDetailService } from './supervisor-detail.service';
import {
  CourseQueryDto,
  DayQueryDto,
  DisciplineQueryDto,
  RecitationsQueryDto,
} from './dto/supervisor-query.dto';
import {
  CreateSupervisorAccountDto,
  SupervisorActiveDto,
  SupervisorPasswordDto,
} from './dto/supervisor-account.dto';

/**
 * ═════════════════════════════════════════════════════════════════════════
 * The course director («مدير الدورة»). Read-only, and nothing else — the
 * only writes here are the director-account routes at the bottom, and those
 * are ADMIN-only: a director cannot create or change any account.
 *
 * Why its own routes instead of giving him ADMIN: an ADMIN can delete
 * students, edit point rules, reset passwords and remove attendance. The
 * director's job is oversight — that his أساتذة record, and record on time —
 * so he gets a role that cannot write at all. Every route here only reads;
 * no SUPERVISOR route exists that writes anything.
 *
 * What a SUPERVISOR token reaches elsewhere: /auth (his own session),
 * GET /announcements (reading), the two /notifications routes that register
 * and remove HIS OWN device token, and — so he can open any student's page
 * exactly as the أستاذ sees it — the GET reads behind that page:
 * /students/:id, /recitations/student/:id/{history,progress,homework,
 * hadith-progress}, /recitations/hadith/rules, /points/student/:id(/rank),
 * /attendance-stats/student/:id(/calendar). Every other route names the
 * roles it allows, and SUPERVISOR is not among them, so it is refused.
 *
 * ADMIN is allowed here too, so Anas can see exactly what the director sees.
 * ═════════════════════════════════════════════════════════════════════════
 */
@Controller('api/v1/supervisor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPERVISOR', 'ADMIN')
export class SupervisorController {
  constructor(
    private readonly supervisor: SupervisorService,
    private readonly detail: SupervisorDetailService,
  ) {}

  // GET /api/v1/supervisor/instructors?termId=&sessions=4
  // The main screen: every حلقة, worst discipline first.
  @Get('instructors')
  instructors(@Query() q: DisciplineQueryDto) {
    return this.supervisor.instructors(q.termId, q.sessions ?? 4);
  }

  // GET /api/v1/supervisor/instructor/:id?termId=
  // One أستاذ: every meeting day of the course and when he recorded it.
  @Get('instructor/:id')
  instructor(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CourseQueryDto,
  ) {
    return this.supervisor.instructor(id, q.termId);
  }

  // GET /api/v1/supervisor/instructor/:id/roster?termId=
  // His students as his own dashboard shows them, plus points gained and
  // points deducted in the course, and each student's school and grade.
  @Get('instructor/:id/roster')
  roster(@Param('id', ParseUUIDPipe) id: string, @Query() q: CourseQueryDto) {
    return this.detail.roster(id, q.termId);
  }

  // GET /api/v1/supervisor/instructor/:id/recitations?from=&to=&termId=
  // What his students recited; without dates, on the last session day.
  @Get('instructor/:id/recitations')
  recitations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: RecitationsQueryDto,
  ) {
    return this.detail.recitations(id, q);
  }

  // GET /api/v1/supervisor/instructor/:id/presence?termId=
  // The أستاذ's own presence as the administration recorded it.
  @Get('instructor/:id/presence')
  presence(@Param('id', ParseUUIDPipe) id: string, @Query() q: CourseQueryDto) {
    return this.detail.presence(id, q.termId);
  }

  // GET /api/v1/supervisor/day?date=&termId=
  @Get('day')
  day(@Query() q: DayQueryDto) {
    return this.supervisor.day(q.date, q.termId);
  }

  // GET /api/v1/supervisor/students?termId=
  @Get('students')
  students(@Query() q: CourseQueryDto) {
    return this.supervisor.students(q.termId);
  }

  // GET /api/v1/supervisor/overview?termId=
  @Get('overview')
  overview(@Query() q: CourseQueryDto) {
    return this.supervisor.overview(q.termId);
  }

  // ── Director accounts: ADMIN only (overrides the class-level roles) ──

  // GET /api/v1/supervisor/accounts
  @Get('accounts')
  @Roles('ADMIN')
  accounts() {
    return this.detail.accounts();
  }

  // POST /api/v1/supervisor/accounts  { username, password }
  @Post('accounts')
  @Roles('ADMIN')
  createAccount(@Body() dto: CreateSupervisorAccountDto) {
    return this.detail.createAccount(dto.username, dto.password);
  }

  // PATCH /api/v1/supervisor/accounts/:id/password  { password }
  @Patch('accounts/:id/password')
  @Roles('ADMIN')
  setPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupervisorPasswordDto,
  ) {
    return this.detail.setPassword(id, dto.password);
  }

  // PATCH /api/v1/supervisor/accounts/:id/active  { isActive }
  @Patch('accounts/:id/active')
  @Roles('ADMIN')
  setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SupervisorActiveDto,
  ) {
    return this.detail.setActive(id, dto.isActive);
  }
}
