import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Web app settings, read once at start-up from the environment.
 *
 * The Flutter web build is served by this same server, from the same origin
 * as the API. Nothing else in the design is as important for security:
 *
 *   • the sign-in cookie stays first-party (Safari blocks third-party
 *     cookies), so it can be HttpOnly + SameSite=Strict;
 *   • the page never needs CORS, so the API answers no browser from any
 *     other origin;
 *   • the Content-Security-Policy can say `'self'` for nearly everything.
 *
 * Variables (all optional):
 *   WEB_APP        "off" stops serving the web app (the API is untouched).
 *   WEB_DIST_DIR   folder holding the Flutter build (default: ./web-dist).
 *   WEB_CSP_MODE   "report-only" sends the CSP without enforcing it — only
 *                  to diagnose a broken page; default is to enforce.
 *   CORS_ORIGINS   comma-separated extra origins allowed to call the API
 *                  from a browser (local development only), e.g.
 *                  "http://localhost:5000". Empty in production.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type CspMode = 'enforce' | 'report-only';

export interface WebAppConfig {
  /** True when WEB_APP is not "off" and the build has an index.html. */
  readonly enabled: boolean;
  /** Absolute path of the Flutter `build/web` copy. */
  readonly distDir: string;
  readonly cspMode: CspMode;
  /** Validated, de-duplicated origins; never contains "*". */
  readonly corsOrigins: readonly string[];
  /** Entries of CORS_ORIGINS that were rejected (logged at start-up). */
  readonly rejectedCorsOrigins: readonly string[];
}

/**
 * Accepts only exact origins: https://host[:port], or http:// for loopback
 * hosts during development. Wildcards, paths, credentials and anything that
 * does not round-trip through `URL.origin` are refused.
 */
export function parseOriginList(raw: string | undefined): {
  origins: string[];
  rejected: string[];
} {
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? '').split(',')) {
    const candidate = entry.trim();
    if (!candidate) continue;
    if (isExactOrigin(candidate)) {
      if (!origins.includes(candidate)) origins.push(candidate);
    } else {
      rejected.push(candidate);
    }
  }
  return { origins, rejected };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isExactOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false; // path, query, trailing "/", userinfo…
  // Wildcards survive URL parsing ("https://*.example.com"); refuse them.
  if (!/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(url.hostname)) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export function loadWebAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): WebAppConfig {
  const rawDir = (env.WEB_DIST_DIR ?? '').trim();
  const distDir = rawDir
    ? isAbsolute(rawDir)
      ? rawDir
      : resolve(cwd, rawDir)
    : join(cwd, 'web-dist');

  const switchedOff = (env.WEB_APP ?? '').trim().toLowerCase() === 'off';
  const enabled = !switchedOff && existsSync(join(distDir, 'index.html'));

  const cspMode: CspMode =
    (env.WEB_CSP_MODE ?? '').trim().toLowerCase() === 'report-only'
      ? 'report-only'
      : 'enforce';

  const { origins, rejected } = parseOriginList(env.CORS_ORIGINS);

  return {
    enabled,
    distDir,
    cspMode,
    corsOrigins: origins,
    rejectedCorsOrigins: rejected,
  };
}

/** Paths that belong to the API, never to the web app. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}
