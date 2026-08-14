import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { StudentsService, StudentStatusFilter } from './students.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Raw shape of the roster query string. Every field arrives as a string (or
 * absent); parsing happens explicitly below rather than through a
 * ValidationPipe, to match the existing convention in this controller and to
 * avoid depending on global transform settings.
 */
interface FindStudentsQuery {
  search?: string;
  instructorId?: string;
  grade?: string;
  status?: string;
  minAge?: string;
  maxAge?: string;
  minJuz?: string;
  maxJuz?: string;
  includePages?: string;
  page?: string;
  limit?: string;
  all?: string;
  termId?: string;
}

const VALID_STATUSES: readonly StudentStatusFilter[] = [
  'active',
  'inactive',
  'all',
];

/** Trims a string parameter and collapses blank values to undefined. */
function optionalString(raw?: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Parses an optional non-negative integer. Rejects malformed input loudly
 * instead of silently coercing it, so a client bug surfaces as a 400 rather
 * than as a quietly unfiltered roster.
 */
function optionalInt(raw: string | undefined, field: string): number | undefined {
  const value = optionalString(raw);
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestException(`قيمة غير صالحة للمعامل ${field}`);
  }
  return parsed;
}

function parseBooleanFlag(raw?: string): boolean {
  return raw === 'true' || raw === '1';
}

@Controller('api/v1/students')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN-ONLY: student creation.
  //
  // Enrolment — including which حلقة a student is assigned to — is an
  // administrative decision. Instructors previously had this permission but
  // never a UI for it: add_student_screen.dart is imported only by admin
  // screens, so narrowing the role breaks no existing client.
  // ═══════════════════════════════════════════════════════════════════════════
  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateStudentDto, @Request() req: any) {
    return this.studentsService.create(dto, req.user.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN-ONLY: mosque-wide roster and filters.
  //
  // This endpoint returns every student in the mosque regardless of حلقة, so
  // an instructor calling it would see students who are not theirs. Rather
  // than scoping results per instructor, the route is closed to admins
  // outright — instructors have no screen that lists all students. Their only
  // use of this controller is GET /students/:id for a single student they are
  // already viewing, which remains open below.
  //
  // Every filter parameter is optional and additive. With none supplied the
  // response is what it was before filters existed (status defaults to
  // 'active', the old hard-coded `deletedAt: null`).
  //
  //   ?grade=السابع              exact match on the free-text grade column
  //   ?instructorId=<uuid>        حلقة
  //   ?status=active|inactive|all lifecycle
  //   ?minAge=10&maxAge=12        inclusive age range, both ends optional
  //   ?minJuz=1&maxJuz=5          inclusive juz range of recited volume
  //   ?includePages=true          attach totalPagesRecited to each student
  //   ?termId=0                   0 = all terms, >0 = specific, absent = active
  // ═══════════════════════════════════════════════════════════════════════════
  @Get()
  @Roles('ADMIN')
  findAll(@Query() query: FindStudentsQuery) {
    const status = optionalString(query.status) as
      | StudentStatusFilter
      | undefined;

    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      throw new BadRequestException(
        `قيمة غير صالحة للمعامل status — المسموح: ${VALID_STATUSES.join(', ')}`,
      );
    }

    const minAge = optionalInt(query.minAge, 'minAge');
    const maxAge = optionalInt(query.maxAge, 'maxAge');
    if (minAge != null && maxAge != null && minAge > maxAge) {
      throw new BadRequestException('minAge لا يمكن أن يكون أكبر من maxAge');
    }

    const minJuz = optionalInt(query.minJuz, 'minJuz');
    const maxJuz = optionalInt(query.maxJuz, 'maxJuz');
    if (minJuz != null && maxJuz != null && minJuz > maxJuz) {
      throw new BadRequestException('minJuz لا يمكن أن يكون أكبر من maxJuz');
    }

    return this.studentsService.findAll({
      search: optionalString(query.search),
      instructorId: optionalString(query.instructorId),
      grade: optionalString(query.grade),
      status,
      minAge,
      maxAge,
      minJuz,
      maxJuz,
      includePages: parseBooleanFlag(query.includePages),
      page: optionalInt(query.page, 'page') ?? 1,
      limit: optionalInt(query.limit, 'limit') ?? 50,
      all: parseBooleanFlag(query.all),
      // Left as undefined when absent so the service falls back to the active
      // term. Note that 0 is a meaningful value here (all terms) and must not
      // be collapsed by a truthiness check.
      termId: optionalInt(query.termId, 'termId'),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILTER OPTIONS — admin-only, mosque-wide by definition.
  // STATIC ROUTES MUST COME BEFORE :id ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('filters/options')
  @Roles('ADMIN')
  getFilterOptions() {
    return this.studentsService.getFilterOptions();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CREDENTIALS MANAGEMENT — admin-only
  // STATIC ROUTES MUST COME BEFORE :id ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('credentials/list')
  @Roles('ADMIN')
  listCredentials(
    @Query('search') search?: string,
    @Query('sentFilter') sentFilter?: 'all' | 'sent' | 'unsent',
  ) {
    return this.studentsService.listCredentials({ search, sentFilter });
  }

  @Post('credentials/regenerate-all')
  @Roles('ADMIN')
  regenerateAll(@Body('confirmationToken') token: string) {
    if (token !== 'REGENERATE_ALL_STUDENT_CREDENTIALS_CONFIRMED') {
      throw new BadRequestException(
        'رمز التأكيد غير صحيح. هذا الإجراء يتطلب تأكيداً صريحاً.',
      );
    }
    return this.studentsService.regenerateAllCredentials();
  }

  // ⚠️ ONE-TIME RECOVERY ENDPOINT — remove after use.
  // Cleans up tmp_<uuid> usernames left over from a failed bulk regen.
  @Post('credentials/recover-parked')
  @Roles('ADMIN')
  recoverParked(@Body('confirmationToken') token: string) {
    if (token !== 'RECOVER_PARKED_USERNAMES_CONFIRMED') {
      throw new BadRequestException('رمز التأكيد غير صحيح');
    }
    return this.studentsService.recoverParkedUsernames();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STUDENT-SPECIFIC ROUTES — must come AFTER static routes.
  //
  // These stay open to instructors: instructor_student_detail_screen.dart
  // depends on GET /students/:id, and the detail screen is reached from a
  // student the instructor is already working with.
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':id')
  @Roles('ADMIN', 'INSTRUCTOR')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('termId') termId?: string,
  ) {
    return this.studentsService.findOne(id, {
      termId: optionalInt(termId, 'termId'),
    });
  }

  @Get(':id/stats')
  @Roles('ADMIN', 'INSTRUCTOR')
  getStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('termId') termId?: string,
  ) {
    return this.studentsService.getStudentStats(id, {
      termId: optionalInt(termId, 'termId'),
    });
  }

  @Put(':id')
  @Roles('ADMIN', 'INSTRUCTOR')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.studentsService.update(id, dto);
  }

  @Post(':id/reset-password')
  @Roles('ADMIN')
  resetPassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.resetPassword(id);
  }

  @Post(':id/mark-credentials-sent')
  @Roles('ADMIN')
  markCredentialsSent(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.markCredentialsSent(id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.remove(id);
  }
}