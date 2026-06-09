import { Module } from '@nestjs/common';
import { PointsController } from './points.controller';
import { PointsService } from './points.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TermsModule } from '../terms/terms.module';

@Module({
  imports: [PrismaModule, TermsModule],
  controllers: [PointsController],
  providers: [PointsService],
  exports: [PointsService],
})
export class PointsModule {}