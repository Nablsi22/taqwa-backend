import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InstructorAttendanceService } from './instructor-attendance.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/instructor-attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InstructorAttendanceController {
  constructor(
    private readonly service: InstructorAttendanceService,
  ) {}

  @Post('mark')
  @Roles('ADMIN')
  mark(@Body() body: any) {
    return this.service.markAttendance(body);
  }

  @Post('mark-bulk')
  @Roles('ADMIN')
  markBulk(@Body() body: any) {
    return this.service.markBulk(body);
  }

  @Get('sheet')
  @Roles('ADMIN')
  getSheet(@Query('date') date: string) {
    return this.service.getSheet(date);
  }

  @Get('history/:instructorId')
  @Roles('ADMIN')
  getHistory(
    @Param('instructorId', ParseUUIDPipe) instructorId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('month') month?: string,
  ) {
    return this.service.getInstructorHistory(instructorId, {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 30,
      month,
    });
  }

  @Get('stats')
  @Roles('ADMIN')
  getAllStats() {
    return this.service.getAllStats();
  }
}