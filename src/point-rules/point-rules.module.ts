import { Module } from '@nestjs/common';
import { PointRulesController } from './point-rules.controller';
import { PointRulesService } from './point-rules.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PointRulesController],
  providers: [PointRulesService],
  exports: [PointRulesService],
})
export class PointRulesModule {}
