import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { QuranPagesService } from './quran-pages.service';

/**
 * GET /api/v1/quran-pages/001.png … /604.png — public Mushaf images for the
 * web app (see QuranPagesService). The same content the phone apps read from
 * mp3quran.net; no account data is involved.
 */
@Controller('api/v1/quran-pages')
export class QuranPagesController {
  constructor(private readonly pages: QuranPagesService) {}

  // A reader turns at most a couple of pages a second.
  @Get(':file')
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  async page(@Param('file') file: string, @Res() res: Response): Promise<void> {
    const match = /^(\d{1,3})\.png$/.exec(file);
    const page = match ? Number(match[1]) : NaN;
    if (!QuranPagesService.isValidPage(page)) {
      throw new NotFoundException('صفحة غير موجودة');
    }

    const png = await this.pages.getPage(page);

    // Public, never-changing content: unlike the rest of the API, cacheable.
    res.removeHeader('Pragma');
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', String(png.length));
    res.status(200).end(png);
  }
}
