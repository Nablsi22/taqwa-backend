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
import { StudentsService } from './students.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/students')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StudentsController {
  constructor(private readonly studentsService: StudentsService) {}

  @Post()
  @Roles('ADMIN', 'INSTRUCTOR')
  create(@Body() dto: CreateStudentDto, @Request() req: any) {
    return this.studentsService.create(dto, req.user.id);
  }

  @Get()
  @Roles('ADMIN', 'INSTRUCTOR')
  findAll(
    @Query('search') search?: string,
    @Query('instructorId') instructorId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('all') all?: string,
  ) {
    return this.studentsService.findAll({
      search,
      instructorId,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      all: all === 'true' || all === '1',
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CREDENTIALS MANAGEMENT — admin-only
  // IMPORTANT: these routes must be declared BEFORE any `:id` route
  // because NestJS matches routes in declaration order. Otherwise
  // `credentials` would be parsed as a UUID and fail.
  // ═══════════════════════════════════════════════════════════════

  // GET /api/v1/students/credentials/list
  @Get('credentials/list')
  @Roles('ADMIN')
  listCredentials(
    @Query('search') search?: string,
    @Query('sentFilter') sentFilter?: 'all' | 'sent' | 'unsent',
  ) {
    return this.studentsService.listCredentials({ search, sentFilter });
  }

  // POST /api/v1/students/credentials/regenerate-all
  // Dangerous! Requires explicit confirmation token in body.
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

  // ═══════════════════════════════════════════════════════════════
  // STUDENT-SPECIFIC ROUTES — must come AFTER static credential routes
  // ═══════════════════════════════════════════════════════════════

  @Get(':id')
  @Roles('ADMIN', 'INSTRUCTOR')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.findOne(id);
  }

  @Get(':id/stats')
  @Roles('ADMIN', 'INSTRUCTOR')
  getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.getStudentStats(id);
  }

  @Put(':id')
  @Roles('ADMIN', 'INSTRUCTOR')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.studentsService.update(id, dto);
  }

  // POST /api/v1/students/:id/reset-password
  // Generates a fresh random password — the admin no longer chooses it.
  @Post(':id/reset-password')
  @Roles('ADMIN')
  resetPassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.studentsService.resetPassword(id);
  }

  // POST /api/v1/students/:id/mark-credentials-sent
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