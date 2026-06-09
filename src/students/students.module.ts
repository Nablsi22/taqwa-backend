import { Module } from '@nestjs/common';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TermsModule } from '../terms/terms.module';

@Module({
  imports: [PrismaModule, TermsModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}