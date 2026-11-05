import express from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { get, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  acceptsEncoding,
  decodeRequestPath,
  resolveAsset,
  WebAssetStore,
  webAppHandler,
} from './web-app';

const BIG_JS = `console.log(${JSON.stringify('x'.repeat(20_000))});\n`;

function makeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'taqwa-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(dir, 'main.dart.js'), BIG_JS);
  writeFileSync(join(dir, 'main.dart.js.map'), '{}');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  mkdirSync(join(dir, 'canvaskit'));
  writeFileSync(
    join(dir, 'canvaskit', 'canvaskit.wasm'),
    Buffer.alloc(4096, 1),
  );
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), '[core]');
  mkdirSync(join(dir, 'icons'));
  writeFileSync(
    join(dir, 'icons', 'Icon-192.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  try {
    symlinkSync('/etc/passwd', join(dir, 'passwd'));
  } catch {
    // Symlinks may be unavailable on this file system; the walk skips them anyway.
  }
  return dir;
}

function makeApp(store: WebAssetStore) {
  const app = express();
  app.use(
    webAppHandler(
      store,
      new Map([
        [
          '/firebase-config.js',
          {
            type: 'text/javascript; charset=utf-8',
            body: Buffer.from('self.X=1;'),
          },
        ],
      ]),
    ),
  );
  app.use((_req, res) => res.status(404).json({ statusCode: 404 }));
  return app;
}

describe('WebAssetStore', () => {
  it('loads only regular, non-hidden files and never source maps or links', () => {
    const store = WebAssetStore.loadSync(makeBuild());
    expect(store.get('/index.html')).toBeDefined();
    expect(store.get('/main.dart.js')).toBeDefined();
    expect(store.get('/canvaskit/canvaskit.wasm')?.type).toBe(
      'application/wasm',
    );
    expect(store.get('/main.dart.js.map')).toBeUndefined();
    expect(store.get('/.env')).toBeUndefined();
    expect(store.get('/.git/config')).toBeUndefined();
    expect(store.get('/passwd')).toBeUndefined();
  });

  it('refuses a build without index.html or over the limits', () => {
    const empty = mkdtempSync(join(tmpdir(), 'taqwa-dist-'));
    expect(() => WebAssetStore.loadSync(empty)).toThrow(/index\.html/);
    expect(() =>
      WebAssetStore.loadSync(makeBuild(), { maxFiles: 2, maxTotalBytes: 1e9 }),
    ).toThrow(/files/);
    expect(() =>
      WebAssetStore.loadSync(makeBuild(), {
        maxFiles: 100,
        maxTotalBytes: 100,
      }),
    ).toThrow(/larger/);
  });

  it('compresses text and wasm, but not PNG', async () => {
    const store = WebAssetStore.loadSync(makeBuild());
    await store.compressAll();
    expect(store.isCompressed).toBe(true);
    expect(store.get('/main.dart.js')?.br).toBeDefined();
    expect(store.get('/main.dart.js')?.gzip).toBeDefined();
    expect(store.get('/canvaskit/canvaskit.wasm')?.br).toBeDefined();
    expect(store.get('/icons/Icon-192.png')?.br).toBeUndefined();
  });
});

describe('path helpers', () => {
  it.each([
    ['/', '/index.html'],
    ['/main.dart.js', '/main.dart.js'],
    ['/%E2%9C%93', '/✓'],
    ['/%zz', null],
    ['/a%00b', null],
    ['/a%5Cb', null],
    ['relative', null],
    ['/../etc/passwd', null],
    ['/a/./b', null],
  ])('decodeRequestPath(%s) → %s', (input, expected) => {
    expect(decodeRequestPath(input)).toBe(expected);
  });

  it('resolves exact files only — no fallback page for unknown paths', () => {
    const store = WebAssetStore.loadSync(makeBuild());
    expect(resolveAsset(store, '/index.html')?.path).toBe('/index.html');
    expect(resolveAsset(store, '/login')).toBeUndefined();
    expect(resolveAsset(store, '/etc/passwd')).toBeUndefined();
    expect(resolveAsset(store, '/missing.js')).toBeUndefined();
    expect(resolveAsset(store, '/.git/config')).toBeUndefined();
    expect(resolveAsset(store, '/.well-known/x')).toBeUndefined();
  });

  it.each([
    ['gzip, deflate, br', 'br', true],
    ['br;q=0, gzip', 'br', false],
    ['gzip;q=0.5', 'gzip', true],
    ['identity', 'gzip', false],
    [undefined, 'br', false],
  ] as const)('acceptsEncoding(%s, %s) → %s', (header, enc, expected) => {
    expect(acceptsEncoding(header, enc)).toBe(expected);
  });
});

describe('webAppHandler', () => {
  let store: WebAssetStore;
  beforeAll(async () => {
    store = WebAssetStore.loadSync(makeBuild());
    await store.compressAll();
  });

  it('serves index.html at / with no-cache and a strong ETag', async () => {
    const res = await request(makeApp(store)).get('/').expect(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{32}"$/);
  });

  it('answers 304 when the ETag matches', async () => {
    const app = makeApp(store);
    const first = await request(app)
      .get('/main.dart.js')
      .set('Accept-Encoding', 'identity');
    await request(app)
      .get('/main.dart.js')
      .set('Accept-Encoding', 'identity')
      .set('If-None-Match', first.headers.etag)
      .expect(304);
  });

  it('sends Brotli when accepted, with its own ETag and Vary', async () => {
    // Raw HTTP: supertest would decompress the body behind our back.
    const server = makeApp(store).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const { headers, body } = await new Promise<{
        headers: IncomingHttpHeaders;
        body: Buffer;
      }>((resolve, reject) => {
        get(
          { port, path: '/main.dart.js', headers: { 'Accept-Encoding': 'br' } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({ headers: res.headers, body: Buffer.concat(chunks) }),
            );
          },
        ).on('error', reject);
      });
      expect(headers['content-encoding']).toBe('br');
      expect(headers.vary).toBe('Accept-Encoding');
      expect(headers.etag).toMatch(/-br"$/);
      expect(body.length).toBeLessThan(BIG_JS.length / 10);
      expect(brotliDecompressSync(body).toString()).toBe(BIG_JS);
    } finally {
      server.close();
    }
  });

  it('serves the dynamic Firebase config ahead of the build', async () => {
    const res = await request(makeApp(store))
      .get('/firebase-config.js')
      .expect(200);
    expect(res.text).toBe('self.X=1;');
  });

  it('answers HEAD with headers only', async () => {
    const res = await request(makeApp(store)).head('/index.html').expect(200);
    expect(res.headers['content-length']).toBeDefined();
    expect(res.text ?? '').toBe('');
  });

  it.each([
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/.env',
    '/.git/config',
    '/main.dart.js.map',
    '/missing.js',
    '/etc/passwd',
  ])('never serves %s', async (path) => {
    const res = await request(makeApp(store)).get(path);
    expect([400, 404]).toContain(res.status);
    expect(res.text).not.toContain('SECRET');
    expect(res.text).not.toContain('root:');
  });

  it('leaves the API and non-GET methods alone', async () => {
    const app = makeApp(store);
    await request(app).get('/api/v1/auth/me').expect(404);
    await request(app).post('/').expect(404);
  });
});
