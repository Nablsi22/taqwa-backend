import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { RecitationService } from './recitation.service';
import {
  CreateRecitationDto,
  CreateRecitationBatchDto,
  BulkMaqraaDto,
} from './dto/create-recitation.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/recitations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecitationController {
  constructor(private readonly recitationService: RecitationService) {}

  // POST /recitations — single recitation (legacy, still supported)
  @Post()
  @Roles('INSTRUCTOR', 'ADMIN')
  async create(@Body() dto: CreateRecitationDto, @Req() req: any) {
    const instructorId = req.user.id;
    return this.recitationService.create(dto, instructorId);
  }

  // POST /recitations/batch — multi-segment session (NEW)
  // Declared as a static route, so it must be BEFORE any `:id` post routes.
  @Post('batch')
  @Roles('INSTRUCTOR', 'ADMIN')
  async createBatch(
    @Body() dto: CreateRecitationBatchDto,
    @Req() req: any,
  ) {
    const instructorId = req.user.id;
    return this.recitationService.createBatch(dto, instructorId);
  }

  // POST /recitations/maqraa — bulk MAQRAA
  @Post('maqraa')
  @Roles('INSTRUCTOR', 'ADMIN')
  async createBulkMaqraa(@Body() dto: BulkMaqraaDto, @Req() req: any) {
    const instructorId = req.user.id;
    return this.recitationService.createBulkMaqraa(dto, instructorId);
  }

  // GET /recitations/suras
  @Get('suras')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  getSuraList() {
    return this.recitationService.getSuraList();
  }

  // GET /recitations/overview
  @Get('overview')
  @Roles('INSTRUCTOR', 'ADMIN')
  async getOverview(@Req() req: any) {
    const instructorId = req.user.id;
    return this.recitationService.getInstructorOverview(instructorId);
  }

  // Static student route — before any student/:id/... matchers below
  @Get('student/:id/next-suggestion')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getNextSuggestion(@Param('id') studentId: string) {
    return this.recitationService.getNextSuggestion(studentId);
  }

  @Get('student/:id/progress')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getStudentProgress(@Param('id') studentId: string) {
    return this.recitationService.getStudentProgress(studentId);
  }

  @Get('student/:id/history')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getStudentRecitations(@Param('id') studentId: string) {
    return this.recitationService.getStudentRecitations(studentId);
  }

  @Get('student/:id/homework')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getStudentHomework(@Param('id') studentId: string) {
    return this.recitationService.getStudentHomework(studentId);
  }

  // DELETE /recitations/:id — admin only
  @Delete(':id')
  @Roles('ADMIN')
  async deleteRecitation(@Param('id', ParseUUIDPipe) id: string) {
    return this.recitationService.deleteRecitation(id);
  }
}