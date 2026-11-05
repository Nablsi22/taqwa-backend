import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { securityHeaders } from './security-headers';
import { WebAssetStore, webAppHandler } from './web-app';

@Controller('api/v1/ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

/**
 * The same wiring as main.ts, on a real Nest app: the middlewares are added
 * with app.use() before init, and must sit in front of Nest's own routes
 * without hiding them.
 */
describe('web app wiring inside Nest', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const dist = mkdtempSync(join(tmpdir(), 'taqwa-boot-'));
    writeFileSync(
      join(dist, 'index.html'),
      '<!doctype html><title>التقوى</title>',
    );
    writeFileSync(join(dist, 'flutter_bootstrap.js'), 'void 0;');

    const module = await Test.createTestingModule({
      controllers: [PingController],
    }).compile();
    const nest = module.createNestApplication<NestExpressApplication>();
    nest.disable('x-powered-by');
    nest.use(securityHeaders({ cspMode: 'enforce' }));
    nest.use(
      webAppHandler(
        WebAssetStore.loadSync(dist),
        new Map([
          [
            '/firebase-config.js',
            {
              type: 'text/javascript; charset=utf-8',
              body: Buffer.from('self.TAQWA_FIREBASE_CONFIG = null;\n'),
            },
          ],
        ]),
      ),
    );
    app = await nest.init();
  });
  afterAll(() => app.close());

  it('serves the page at / with the web policy', async () => {
    const res = await request(app.getHttpServer()).get('/').expect(200);
    expect(res.text).toContain('التقوى');
    expect(res.headers['content-security-policy']).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('still routes the API, with the API policy', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/ping')
      .expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
    );
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers an unknown page path with 404 and hardened headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .expect(404);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('serves the generated Firebase config', async () => {
    const res = await request(app.getHttpServer())
      .get('/firebase-config.js')
      .expect(200);
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.text).toContain('TAQWA_FIREBASE_CONFIG');
  });
});
