import { Body, Controller, Get, Post, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SubstituteService } from './substitute.service';
import {
  CoverageDayQueryDto,
  CoverageDto,
  HalaqaRosterQueryDto,
} from './dto/substitute.dto';

/**
 * «حلقات أخرى» — recording by proxy for another حلقة.
 *
 * Unlike every other /instructors route, the picker here is open to an
 * INSTRUCTOR: a substitute has to be able to find the حلقة he is covering.
 * He gets names and the day's counters, nothing else.
 *
 * The recording itself goes through the ordinary routes — GET
 * /attendance/sheet?instructorId=…, POST /attendance/mark, POST
 * /recitation — which are not scoped to the caller's own حلقة and already
 * record who marked each row.
 */
@Controller('api/v1/substitute')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubstituteController {
  constructor(private readonly substitute: SubstituteService) {}

  // GET /api/v1/substitute/halaqas?date=YYYY-MM-DD
  @Get('halaqas')
  @Roles('ADMIN', 'INSTRUCTOR')
  halaqas(
    @Query() q: CoverageDayQueryDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.substitute.otherHalaqas(
      { userId: req.user.id, role: req.user.role },
      q.date,
    );
  }

  // GET /api/v1/substitute/roster?instructorId=…&date=&termId=
  @Get('roster')
  @Roles('ADMIN', 'INSTRUCTOR')
  roster(
    @Query() q: HalaqaRosterQueryDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.substitute.halaqaRoster(
      { userId: req.user.id, role: req.user.role },
      q.instructorId,
      q.date,
      q.termId,
    );
  }

  // GET /api/v1/substitute/coverage?date=YYYY-MM-DD
  @Get('coverage')
  @Roles('ADMIN', 'INSTRUCTOR')
  coverage(
    @Query() q: CoverageDayQueryDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.substitute.coverage(
      { userId: req.user.id, role: req.user.role },
      q.date,
    );
  }

  // POST /api/v1/substitute/coverage — «استلمت هالحلقة اليوم»
  @Post('coverage')
  @Roles('INSTRUCTOR')
  claim(
    @Body() dto: CoverageDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.substitute.claim(
      { userId: req.user.id, role: req.user.role },
      dto,
    );
  }

  // POST /api/v1/substitute/coverage/release — undo the claim only.
  // Declared as its own path so no route resolves 'release' as a value.
  @Post('coverage/release')
  @Roles('INSTRUCTOR')
  release(
    @Body() dto: CoverageDto,
    @Request() req: { user: { id: string; role: string } },
  ) {
    return this.substitute.release(
      { userId: req.user.id, role: req.user.role },
      dto,
    );
  }
}
