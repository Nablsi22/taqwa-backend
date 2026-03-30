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
  ParseUUIDPipe,
} from '@nestjs/common';
import { InstructorsService } from './instructors.service';
import { CreateInstructorDto } from './dto/create-instructor.dto';
import { UpdateInstructorDto } from './dto/update-instructor.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/instructors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InstructorsController {
  constructor(private readonly instructorsService: InstructorsService) {}

  /**
   * GET /api/v1/instructors
   * List all instructors (admin only)
   */
  @Get()
  @Roles('ADMIN')
  findAll(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.instructorsService.findAll({
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  /**
   * GET /api/v1/instructors/:id
   * Get instructor details with student list
   */
  @Get(':id')
  @Roles('ADMIN')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.instructorsService.findOne(id);
  }

  /**
   * POST /api/v1/instructors
   * Create a new instructor
   */
  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateInstructorDto) {
    return this.instructorsService.create(dto);
  }

  /**
   * PUT /api/v1/instructors/:id
   * Update instructor details
   */
  @Put(':id')
  @Roles('ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInstructorDto,
  ) {
    return this.instructorsService.update(id, dto);
  }

  /**
   * DELETE /api/v1/instructors/:id
   * Delete instructor (only if no students assigned)
   */
  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.instructorsService.remove(id);
  }

  /**
   * POST /api/v1/instructors/:id/reset-password
   * Reset instructor's password
   */
  @Post(':id/reset-password')
  @Roles('ADMIN')
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('password') password: string,
  ) {
    return this.instructorsService.resetPassword(id, password);
  }
}