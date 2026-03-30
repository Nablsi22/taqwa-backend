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
} from '@nestjs/common';
import { PointsService } from './points.service';
import { AwardPointsDto } from './dto/award-points.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Controller('api/v1/points')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PointsController {
  constructor(private readonly pointsService: PointsService) {}

  /**
   * GET /api/v1/points/categories
   * Get all active point categories
   */
  @Get('categories')
  @Roles('ADMIN', 'INSTRUCTOR')
  getCategories() {
    return this.pointsService.getCategories();
  }

  /**
   * POST /api/v1/points/award
   * Award points to a student
   */
  @Post('award')
  @Roles('ADMIN', 'INSTRUCTOR')
  award(@Body() dto: AwardPointsDto, @Request() req: any) {
    return this.pointsService.awardPoints(dto, req.user.id);
  }

  /**
   * GET /api/v1/points/student/:studentId
   * Get points history for a student
   */
  @Get('student/:studentId')
  @Roles('ADMIN', 'INSTRUCTOR', 'STUDENT')
  getStudentPoints(
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.pointsService.getStudentPoints(studentId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 30,
    });
  }

  /**
   * GET /api/v1/points/leaderboard
   * Get leaderboard ranked by total points
   */
  @Get('leaderboard')
  @Roles('ADMIN', 'INSTRUCTOR', 'STUDENT')
  getLeaderboard(
    @Query('limit') limit?: string,
    @Query('instructorId') instructorId?: string,
  ) {
    return this.pointsService.getLeaderboard({
      limit: limit ? parseInt(limit, 10) : 20,
      instructorId,
    });
  }

  /**
   * DELETE /api/v1/points/log/:id
   * Delete a points log entry
   */
  @Delete('log/:id')
  @Roles('ADMIN')
  deleteLog(@Param('id', ParseUUIDPipe) id: string) {
    return this.pointsService.deleteLog(id);
  }
  @Put('categories/:id')
  @Roles('ADMIN')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.pointsService.updateCategory(id, dto);
  }
}