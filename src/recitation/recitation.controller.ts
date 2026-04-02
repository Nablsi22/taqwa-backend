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
import { CreateRecitationDto, BulkMaqraaDto } from './dto/create-recitation.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/recitations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecitationController {
  constructor(private readonly recitationService: RecitationService) {}

  // POST /recitations — Create a single recitation
  @Post()
  @Roles('INSTRUCTOR', 'ADMIN')
  async create(@Body() dto: CreateRecitationDto, @Req() req: any) {
    const instructorId = req.user.id;
    return this.recitationService.create(dto, instructorId);
  }

  // POST /recitations/maqraa — Bulk MAQRAA for multiple students
  @Post('maqraa')
  @Roles('INSTRUCTOR', 'ADMIN')
  async createBulkMaqraa(@Body() dto: BulkMaqraaDto, @Req() req: any) {
    const instructorId = req.user.id;
    return this.recitationService.createBulkMaqraa(dto, instructorId);
  }

  // GET /recitations/suras — Get list of all 114 suras
  @Get('suras')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  getSuraList() {
    return this.recitationService.getSuraList();
  }

  // GET /recitations/overview — Instructor's students overview
  @Get('overview')
  @Roles('INSTRUCTOR', 'ADMIN')
  async getOverview(@Req() req: any) {
    const instructorId = req.user.id;
    return this.recitationService.getInstructorOverview(instructorId);
  }

  // GET /recitations/student/:id/progress — Full memorization map
  @Get('student/:id/progress')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getStudentProgress(@Param('id') studentId: string) {
    return this.recitationService.getStudentProgress(studentId);
  }

  // GET /recitations/student/:id/history — Recitation log
  @Get('student/:id/history')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getStudentRecitations(@Param('id') studentId: string) {
    return this.recitationService.getStudentRecitations(studentId);
  }

  // GET /recitations/student/:id/homework — Latest homework
  @Get('student/:id/homework')
  @Roles('INSTRUCTOR', 'ADMIN', 'STUDENT')
  async getStudentHomework(@Param('id') studentId: string) {
    return this.recitationService.getStudentHomework(studentId);
  }

  // DELETE /recitations/:id — Delete a recitation entry (admin only)
  @Delete(':id')
  @Roles('ADMIN')
  async deleteRecitation(@Param('id', ParseUUIDPipe) id: string) {
    return this.recitationService.deleteRecitation(id);
  }
}
