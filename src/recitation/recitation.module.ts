import { Module } from '@nestjs/common';
import { RecitationController } from './recitation.controller';
import { RecitationService } from './recitation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PointRulesModule } from '../point-rules/point-rules.module';
import { TermsModule } from '../terms/terms.module';

@Module({
  imports: [PrismaModule, PointRulesModule, TermsModule],
  controllers: [RecitationController],
  providers: [RecitationService],
  exports: [RecitationService],
})
export class RecitationModule {}
