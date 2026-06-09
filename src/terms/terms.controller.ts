import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { TermsService } from './terms.service';
import { CreateTermDto } from './dto/create-term.dto';
import { UpdateTermDto } from './dto/update-term.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/terms')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TermsController {
  constructor(private readonly termsService: TermsService) {}

  // GET /api/v1/terms
  @Get()
  @Roles('ADMIN', 'INSTRUCTOR')
  findAll() {
    return this.termsService.findAll();
  }

  // Static routes BEFORE :id parameterized routes
  @Get('active')
  @Roles('ADMIN', 'INSTRUCTOR')
  findActive() {
    return this.termsService.findActive();
  }

  @Get(':id/stats')
  @Roles('ADMIN', 'INSTRUCTOR')
  getStats(@Param('id', ParseIntPipe) id: number) {
    return this.termsService.getStats(id);
  }

  @Get(':id')
  @Roles('ADMIN', 'INSTRUCTOR')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.termsService.findOne(id);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: CreateTermDto) {
    return this.termsService.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTermDto,
  ) {
    return this.termsService.update(id, dto);
  }

  @Patch(':id/activate')
  @Roles('ADMIN')
  activate(@Param('id', ParseIntPipe) id: number) {
    return this.termsService.activate(id);
  }
}