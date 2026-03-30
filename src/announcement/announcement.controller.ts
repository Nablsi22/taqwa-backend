import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AnnouncementService } from './announcement.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/announcements')
@UseGuards(JwtAuthGuard)
export class AnnouncementController {
  constructor(private readonly service: AnnouncementService) {}

  // ─── Admin + Instructor: Create announcement ──────────────────────────────
  // Admin  → broadcast to ALL users
  // Instructor → only their students will see it
  @Post()
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'INSTRUCTOR')
  create(@Body() dto: CreateAnnouncementDto, @Request() req: any) {
    return this.service.create(dto, req.user.id);
  }

  // ─── All roles: List announcements (auto-filtered by role) ────────────────
  @Get()
  findAll(@Request() req: any) {
    return this.service.findAll(req.user.id, req.user.role);
  }

  // ─── All roles: Get single announcement ───────────────────────────────────
  @Get('stats')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  getStats() {
    return this.service.getStats();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  // ─── Admin + Instructor: Update own announcement ──────────────────────────
  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'INSTRUCTOR')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
    @Request() req: any,
  ) {
    return this.service.update(id, dto, req.user.id, req.user.role);
  }

  // ─── Admin only: Toggle pin ───────────────────────────────────────────────
  @Patch(':id/pin')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  togglePin(@Param('id') id: string) {
    return this.service.togglePin(id);
  }

  // ─── Admin + Instructor: Delete own announcement ──────────────────────────
  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'INSTRUCTOR')
  remove(@Param('id') id: string, @Request() req: any) {
    return this.service.remove(id, req.user.id, req.user.role);
  }
}
