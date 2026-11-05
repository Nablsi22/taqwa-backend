import { BadGatewayException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { QuranPagesController } from './quran-pages.controller';
import { QuranPagesService } from './quran-pages.service';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(100, 7),
]);

function upstream(
  body: Buffer,
  init: { status?: number; type?: string; length?: number } = {},
) {
  return new Response(new Uint8Array(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': init.type ?? 'image/png',
      ...(init.length !== undefined
        ? { 'content-length': String(init.length) }
        : {}),
    },
  });
}

describe('QuranPagesService', () => {
  it('fetches only the fixed mp3quran address, without following redirects', async () => {
    const service = new QuranPagesService();
    const fetcher = jest.fn().mockResolvedValue(upstream(PNG));
    service.fetcher = fetcher;
    await expect(service.getPage(7)).resolves.toEqual(PNG);
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.mp3quran.net/api/quran_pages_arabic/007.png',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('caches, de-duplicates concurrent requests and stays bounded', async () => {
    const service = new QuranPagesService();
    const fetcher = jest
      .fn()
      .mockImplementation(() => Promise.resolve(upstream(PNG)));
    service.fetcher = fetcher;
    await Promise.all([
      service.getPage(1),
      service.getPage(1),
      service.getPage(1),
    ]);
    await service.getPage(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (let p = 2; p <= QuranPagesService.MAX_CACHED_PAGES + 10; p += 1)
      await service.getPage(p);
    fetcher.mockClear();
    await service.getPage(1); // evicted long ago
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([0, 605, 1.5, -1, Number.NaN])('refuses page %p', async (page) => {
    await expect(new QuranPagesService().getPage(page)).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it.each([
    ['an HTTP error', () => upstream(PNG, { status: 500 })],
    [
      'something that is not a PNG',
      () => upstream(Buffer.from('<html>evil</html>'), { type: 'text/html' }),
    ],
    [
      'an oversized declared body',
      () => upstream(PNG, { length: 10 * 1024 * 1024 }),
    ],
    [
      'an oversized actual body',
      () => upstream(Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)])),
    ],
  ])('answers 502 for %s', async (_label, make) => {
    const service = new QuranPagesService();
    service.fetcher = jest
      .fn()
      .mockImplementation(() => Promise.resolve(make()));
    await expect(service.getPage(3)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('answers 502 when the network fails, and retries next time', async () => {
    const service = new QuranPagesService();
    service.fetcher = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(upstream(PNG));
    await expect(service.getPage(9)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    await expect(service.getPage(9)).resolves.toEqual(PNG);
  });
});

describe('QuranPagesController over HTTP', () => {
  let app: INestApplication;
  const pages = { getPage: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [QuranPagesController],
      providers: [{ provide: QuranPagesService, useValue: pages }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());

  it('serves a page as a cacheable PNG', async () => {
    pages.getPage.mockResolvedValue(PNG);
    const res = await request(app.getHttpServer())
      .get('/api/v1/quran-pages/001.png')
      .expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe(
      'public, max-age=2592000, immutable',
    );
    expect(pages.getPage).toHaveBeenCalledWith(1);
  });

  it.each([
    '000.png',
    '605.png',
    'abc.png',
    '1.jpg',
    '..%2F..%2Fetc%2Fpasswd',
    '1.png.png',
  ])('answers 404 for %s', async (file) => {
    pages.getPage.mockClear();
    await request(app.getHttpServer())
      .get(`/api/v1/quran-pages/${file}`)
      .expect(404);
    expect(pages.getPage).not.toHaveBeenCalled();
  });
});
