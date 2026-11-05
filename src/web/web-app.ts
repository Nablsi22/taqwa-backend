import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isApiPath } from './web-config';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The Flutter web build, served from memory.
 *
 * Every file of the build is read once at start-up into an allow-list keyed
 * by its exact URL path. A request is answered only if its path is one of
 * those keys, so no request ever reaches the file system: path traversal,
 * dot-files, symlinks and source maps are impossible by construction, not
 * by filtering.
 *
 * Caching: everything is `no-cache` + a strong ETag (a content hash), so a
 * browser revalidates each file and gets `304 Not Modified` when nothing
 * changed, and a new release is picked up on the next open — never a mix of
 * an old index.html with a new main.dart.js.
 *
 * Compression: Brotli and gzip copies are made in the background after
 * start-up (main.dart.js and canvaskit.wasm shrink by ~70 %, which matters
 * on slow mobile networks). Until they are ready, files are sent as-is.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.frag': 'application/octet-stream',
};

/** Already-compressed formats gain nothing from Brotli/gzip. */
const INCOMPRESSIBLE = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff',
  '.woff2',
]);

/** Never served even if someone copies them into the build folder. */
const EXCLUDED_EXTENSIONS = new Set(['.map', '.br', '.gz', '.bak', '.tmp']);

export interface WebAssetLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_LIMITS: WebAssetLimits = {
  maxFiles: 10_000,
  maxTotalBytes: 300 * 1024 * 1024,
};

export interface WebAsset {
  readonly path: string;
  readonly type: string;
  readonly body: Buffer;
  readonly etag: string;
  readonly compressible: boolean;
  br?: Buffer;
  gzip?: Buffer;
}

function etagOf(body: Buffer, suffix = ''): string {
  const digest = createHash('sha256').update(body).digest('base64url');
  return `"${digest.slice(0, 32)}${suffix}"`;
}

export class WebAssetStore {
  private readonly assets = new Map<string, WebAsset>();
  private compressed = false;

  private constructor() {}

  /** Reads the whole build into memory. Throws on any limit breach. */
  static loadSync(
    distDir: string,
    limits: WebAssetLimits = DEFAULT_LIMITS,
  ): WebAssetStore {
    const store = new WebAssetStore();
    let totalBytes = 0;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; // dot-files and dot-folders
        if (entry.isSymbolicLink()) continue; // never follow links out of the build
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;

        const ext = extname(entry.name).toLowerCase();
        if (EXCLUDED_EXTENSIONS.has(ext)) continue;

        const size = statSync(full).size;
        totalBytes += size;
        if (store.assets.size + 1 > limits.maxFiles) {
          throw new Error(`Web build has more than ${limits.maxFiles} files`);
        }
        if (totalBytes > limits.maxTotalBytes) {
          throw new Error(
            `Web build is larger than ${limits.maxTotalBytes} bytes`,
          );
        }

        const urlPath =
          '/' + relative(distDir, full).split(sep).join(posix.sep);
        const body = readFileSync(full);
        store.assets.set(urlPath, {
          path: urlPath,
          type: CONTENT_TYPES[ext] ?? 'application/octet-stream',
          body,
          etag: etagOf(body),
          compressible: !INCOMPRESSIBLE.has(ext),
        });
      }
    };

    walk(distDir);
    if (!store.assets.has('/index.html')) {
      throw new Error(`No index.html in ${distDir}`);
    }
    return store;
  }

  get size(): number {
    return this.assets.size;
  }

  get isCompressed(): boolean {
    return this.compressed;
  }

  get(path: string): WebAsset | undefined {
    return this.assets.get(path);
  }

  /**
   * Makes Brotli (quality 11) and gzip (level 9) copies, one file at a time
   * on libuv's thread pool, so requests keep being served meanwhile. A copy
   * is kept only when it is clearly smaller than the original.
   */
  async compressAll(): Promise<{ files: number; savedBytes: number }> {
    let files = 0;
    let savedBytes = 0;
    for (const asset of this.assets.values()) {
      if (!asset.compressible || asset.body.length < 1024) continue;
      const isText =
        asset.type.startsWith('text/') || asset.type.includes('json');
      const [br, gz] = await Promise.all([
        brotli(asset.body, {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: asset.body.length,
            [zlibConstants.BROTLI_PARAM_MODE]: isText
              ? zlibConstants.BROTLI_MODE_TEXT
              : zlibConstants.BROTLI_MODE_GENERIC,
          },
        }),
        gzipAsync(asset.body, { level: 9 }),
      ]);
      const worthIt = (copy: Buffer) => copy.length < asset.body.length * 0.95;
      if (worthIt(br)) asset.br = br;
      if (worthIt(gz)) asset.gzip = gz;
      if (asset.br || asset.gzip) {
        files += 1;
        savedBytes +=
          asset.body.length - (asset.br ?? asset.gzip ?? asset.body).length;
      }
    }
    this.compressed = true;
    return { files, savedBytes };
  }
}

/** True when the client lists `encoding` with a non-zero quality. */
export function acceptsEncoding(
  header: string | undefined,
  encoding: 'br' | 'gzip',
): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    if (name.toLowerCase() !== encoding) continue;
    const q = params.find((p) => p.toLowerCase().startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  }
  return false;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === etag);
}

/** Decodes a URL path; null for anything malformed or suspicious. */
export function decodeRequestPath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.includes('\0') ||
    decoded.includes('\\')
  ) {
    return null;
  }
  // "." / ".." segments are never legitimate here; refuse rather than normalise.
  if (
    decoded.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }
  return decoded === '/' ? '/index.html' : decoded;
}

/**
 * The asset for a path — the exact file or nothing. There is no "SPA
 * fallback": the app keeps its in-app location after the "#" (Flutter's
 * default hash URL strategy), so the server only ever sees "/" and real
 * file names, and every other path is an honest 404.
 */
export function resolveAsset(
  store: WebAssetStore,
  path: string,
): WebAsset | undefined {
  return store.get(path);
}

export interface DynamicAsset {
  readonly type: string;
  readonly body: Buffer;
}

export function webAppHandler(
  store: WebAssetStore,
  dynamicAssets: ReadonlyMap<string, DynamicAsset> = new Map(),
): RequestHandler {
  const dynamic = new Map(
    [...dynamicAssets].map(([path, a]) => [
      path,
      { ...a, path, etag: etagOf(a.body), compressible: false } as WebAsset,
    ]),
  );

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isApiPath(req.path)) return next();

    const path = decodeRequestPath(req.path);
    if (path === null) {
      res.status(400).end();
      return;
    }

    const asset = dynamic.get(path) ?? resolveAsset(store, path);
    if (!asset) return next();

    const acceptEncoding = req.headers['accept-encoding'];
    let body = asset.body;
    let encoding: 'br' | 'gzip' | undefined;
    if (asset.br && acceptsEncoding(acceptEncoding, 'br')) {
      body = asset.br;
      encoding = 'br';
    } else if (asset.gzip && acceptsEncoding(acceptEncoding, 'gzip')) {
      body = asset.gzip;
      encoding = 'gzip';
    }
    const etag = encoding
      ? asset.etag.replace(/"$/, `-${encoding}"`)
      : asset.etag;

    res.setHeader('Content-Type', asset.type);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (asset.br || asset.gzip) res.setHeader('Vary', 'Accept-Encoding');

    if (matchesEtag(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return;
    }

    if (encoding) res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', String(body.length));
    res.status(200);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(body);
  };
}
