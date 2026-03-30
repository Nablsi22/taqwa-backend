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
import { GiftsService } from './gifts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('api/v1/gifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GiftsController {
  constructor(private readonly giftsService: GiftsService) {}

  @Get()
  @Roles('ADMIN', 'INSTRUCTOR', 'STUDENT')
  findAll(@Query('available') available?: string) {
    return this.giftsService.findAll(available === 'true');
  }

  @Get(':id')
  @Roles('ADMIN')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.giftsService.findOne(id);
  }

  @Post()
  @Roles('ADMIN')
  create(@Body() dto: any) {
    return this.giftsService.create(dto);
  }

  @Put(':id')
  @Roles('ADMIN')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: any) {
    return this.giftsService.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.giftsService.remove(id);
  }
}
