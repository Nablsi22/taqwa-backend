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

  @Get()
  @Roles('ADMIN', 'INSTRUCTOR')
  findAll() {
    return this.pointRulesService.findAll();
  }

  @Get('manual')
  @Roles('ADMIN', 'INSTRUCTOR')
  getManualRules() {
    return this.pointRulesService.getManualRules();
  }

  @Put(':id')
  @Roles('ADMIN')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.pointRulesService.updatePoints(id, dto.points);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: any) {
    return this.pointRulesService.createManualRule(dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.pointRulesService.remove(id);
  }
}