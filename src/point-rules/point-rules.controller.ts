import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PointRulesService } from './point-rules.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/point-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PointRulesController {
  constructor(private readonly pointRulesService: PointRulesService) {}

  /** GET all rules */
  @Get()
  @Roles('ADMIN', 'INSTRUCTOR')
  findAll() {
    return this.pointRulesService.findAll();
  }

  /** GET manual rules only (for instructor quick-apply) */
  @Get('manual')
  @Roles('ADMIN', 'INSTRUCTOR')
  getManualRules() {
    return this.pointRulesService.getManualRules();
  }

  /** PUT update point value only */
  @Put(':id')
  @Roles('ADMIN')
  updatePoints(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { points: number },
  ) {
    return this.pointRulesService.updatePoints(id, body.points);
  }

  /** POST add a new manual rule */
  @Post()
  @Roles('ADMIN')
  createManualRule(@Body() body: { nameAr: string; points: number; description?: string }) {
    return this.pointRulesService.createManualRule(body);
  }

  /** DELETE a custom rule (only deletable ones) */
  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.pointRulesService.remove(id);
  }
}
