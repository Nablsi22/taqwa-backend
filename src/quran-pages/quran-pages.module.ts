import { Module } from '@nestjs/common';
import { QuranPagesController } from './quran-pages.controller';
import { QuranPagesService } from './quran-pages.service';

@Module({
  controllers: [QuranPagesController],
  providers: [QuranPagesService],
})
export class QuranPagesModule {}
