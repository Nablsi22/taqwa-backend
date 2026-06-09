import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TermsService } from './terms.service';
import { TermsController } from './terms.controller';

@Module({
  imports:     [PrismaModule],
  controllers: [TermsController],
  providers:   [TermsService],
  exports:     [TermsService], // exported so PointsModule/StudentsModule can inject
})
export class TermsModule {}