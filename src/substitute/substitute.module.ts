import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SubstituteController } from './substitute.controller';
import { SubstituteService } from './substitute.service';

@Module({
  imports: [PrismaModule],
  controllers: [SubstituteController],
  providers: [SubstituteService],
  // exported for the 9 pm reminder and the 11 pm director summary, which
  // both need to know who covered a حلقة.
  exports: [SubstituteService],
})
export class SubstituteModule {}
