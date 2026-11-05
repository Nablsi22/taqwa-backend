import { BadGatewayException, Injectable, Logger } from '@nestjs/common';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Mushaf page images for the web app, served from this origin.
 *
 * The phone apps load the 604 page images straight from mp3quran.net. A web
 * page cannot: the browser would need that site's CORS permission to draw
 * them, and the page's Content-Security-Policy allows images from this
 * origin only. So the server fetches each page once and passes it on.
 *
 * This is NOT a general proxy: the only URL it ever requests is the fixed
 * mp3quran.net page address for a whole number 1..604, redirects are
 * refused, and only a real PNG under 3 MB is accepted. Recently used pages
 * stay in memory (bounded), and browsers cache each page for 30 days.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const FIRST_PAGE = 1;
export const LAST_PAGE = 604;

const UPSTREAM = 'https://www.mp3quran.net/api/quran_pages_arabic/';
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<globalThis.Response>;

@Injectable()
export class QuranPagesService {
  private readonly logger = new Logger(QuranPagesService.name);
  private readonly cache = new Map<number, Buffer>();
  private readonly inFlight = new Map<number, Promise<Buffer>>();

  static readonly MAX_CACHED_PAGES = 120;
  static readonly MAX_BYTES = 3 * 1024 * 1024;
  static readonly TIMEOUT_MS = 10_000;

  /** Replaceable in tests. */
  fetcher: Fetcher = (url, init) => fetch(url, init);

  static isValidPage(page: number): boolean {
    return Number.isInteger(page) && page >= FIRST_PAGE && page <= LAST_PAGE;
  }

  static upstreamUrl(page: number): string {
    return `${UPSTREAM}${String(page).padStart(3, '0')}.png`;
  }

  async getPage(page: number): Promise<Buffer> {
    if (!QuranPagesService.isValidPage(page)) {
      throw new RangeError(
        `Page ${page} is outside ${FIRST_PAGE}..${LAST_PAGE}`,
      );
    }

    const cached = this.cache.get(page);
    if (cached) {
      // Least-recently-used order: move to the end.
      this.cache.delete(page);
      this.cache.set(page, cached);
      return cached;
    }

    const pending = this.inFlight.get(page);
    if (pending) return pending;

    const request = this.download(page)
      .then((png) => {
        this.remember(page, png);
        return png;
      })
      .finally(() => this.inFlight.delete(page));
    this.inFlight.set(page, request);
    return request;
  }

  private remember(page: number, png: Buffer): void {
    this.cache.set(page, png);
    while (this.cache.size > QuranPagesService.MAX_CACHED_PAGES) {
      const [oldest] = this.cache.keys();
      this.cache.delete(oldest);
    }
  }

  private async download(page: number): Promise<Buffer> {
    const unavailable = () =>
      new BadGatewayException(
        'تعذّر تحميل صفحة المصحف الآن، أعد المحاولة بعد قليل',
      );

    let response: globalThis.Response;
    try {
      response = await this.fetcher(QuranPagesService.upstreamUrl(page), {
        redirect: 'error',
        signal: AbortSignal.timeout(QuranPagesService.TIMEOUT_MS),
        headers: { Accept: 'image/png' },
      });
    } catch (err) {
      this.logger.warn(`Page ${page}: upstream unreachable (${String(err)})`);
      throw unavailable();
    }

    if (!response.ok || !response.body) {
      this.logger.warn(`Page ${page}: upstream answered ${response.status}`);
      throw unavailable();
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > QuranPagesService.MAX_BYTES) throw unavailable();

    // Read with a hard cap, whatever Content-Length claimed.
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > QuranPagesService.MAX_BYTES) {
        await reader.cancel();
        throw unavailable();
      }
      chunks.push(Buffer.from(value));
    }

    const png = Buffer.concat(chunks, total);
    if (
      png.length < PNG_SIGNATURE.length ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE)
    ) {
      this.logger.warn(`Page ${page}: upstream did not return a PNG`);
      throw unavailable();
    }
    return png;
  }
}
