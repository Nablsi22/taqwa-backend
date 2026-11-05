import { ForbiddenException } from '@nestjs/common';
import { parseOriginList } from '../web/web-config';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Web sign-in session — how the browser keeps a user signed in.
 *
 * The phone apps keep both tokens in the OS keystore. A browser has no such
 * place: anything JavaScript can read, an XSS bug could steal. So on the web:
 *
 *   • the access token (15 min) lives only in the page's memory;
 *   • the refresh token lives in a cookie JavaScript cannot read:
 *       __Host-taqwa_rt   HttpOnly; Secure; SameSite=Strict; Path=/
 *     "__Host-" makes the browser refuse it unless it is Secure, has no
 *     Domain and Path=/ — no other (sub)domain can plant or read it;
 *   • every refresh rotates the cookie, and a web session ends for good after
 *     WEB_SESSION_MAX (default 30 days) even if used daily;
 *   • web refresh tokens carry aud "taqwa-web" and are refused by the phone
 *     endpoint, and phone tokens are refused by the web endpoints.
 *
 * Cross-site request forgery: a cookie is sent automatically, so the three
 * cookie endpoints also require (1) the custom header X-Taqwa-Client: web,
 * which a cross-site form or <img> cannot send and a cross-site fetch cannot
 * send without a CORS preflight this server never approves, (2) a same-origin
 * `Origin` and (3) `Sec-Fetch-Site: same-origin` when the browser sends them.
 * SameSite=Strict is the first line; these are defence in depth.
 *
 * Refs: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
 *       https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
 *       https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis (cookie prefixes)
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const WEB_REFRESH_COOKIE = '__Host-taqwa_rt';
export const WEB_CLIENT_HEADER = 'x-taqwa-client';
export const WEB_CLIENT_VALUE = 'web';
export const WEB_TOKEN_AUDIENCE = 'taqwa-web';

/** Defaults; override with WEB_REFRESH_TTL / WEB_SESSION_MAX. */
export const DEFAULT_WEB_REFRESH_TTL = '14d';
export const DEFAULT_WEB_SESSION_MAX = '30d';

const MAX_COOKIE_HEADER = 8192;
const MAX_COOKIE_PAIRS = 64;

/**
 * Minimal RFC 6265 cookie-header parser. The first occurrence of a name wins
 * (the browser sends the most specific path first). Oversized headers are
 * ignored rather than parsed.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header || header.length > MAX_COOKIE_HEADER) return cookies;
  let pairs = 0;
  for (const part of header.split(';')) {
    if (++pairs > MAX_COOKIE_PAIRS) break;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/** A JWT is three base64url segments — nothing else is accepted from the cookie. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function readRefreshCookie(
  header: string | undefined,
): string | undefined {
  const value = parseCookies(header).get(WEB_REFRESH_COOKIE);
  return value && value.length <= 4096 && JWT_SHAPE.test(value)
    ? value
    : undefined;
}

export function serializeRefreshCookie(
  token: string,
  maxAgeSeconds: number,
): string {
  if (!JWT_SHAPE.test(token))
    throw new Error('Refusing to set a malformed refresh cookie');
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return [
    `${WEB_REFRESH_COOKIE}=${token}`,
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Priority=High',
  ].join('; ');
}

export function serializeClearedRefreshCookie(): string {
  return [
    `${WEB_REFRESH_COOKIE}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

export interface HeaderSource {
  headers: Record<string, string | string[] | undefined>;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Refuses (403) a cookie-endpoint call that did not come from this site's own
 * web app. `extraOrigins` defaults to CORS_ORIGINS (local development).
 */
export function assertTrustedWebRequest(
  req: HeaderSource,
  extraOrigins: readonly string[] = parseOriginList(process.env.CORS_ORIGINS)
    .origins,
): void {
  const refuse = () => {
    throw new ForbiddenException('طلب غير مسموح به');
  };

  if (
    single(req.headers[WEB_CLIENT_HEADER])?.toLowerCase() !== WEB_CLIENT_VALUE
  )
    refuse();

  const fetchSite = single(req.headers['sec-fetch-site'])?.toLowerCase();
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    // A listed development origin on another port is same-site, not same-origin.
    if (!(fetchSite === 'same-site' && extraOrigins.length > 0)) refuse();
  }

  const origin = single(req.headers.origin);
  if (origin !== undefined) {
    if (origin === 'null') refuse();
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return refuse();
    }
    // Railway forwards the public Host; X-Forwarded-Host is accepted too in
    // case a proxy in front rewrites Host. Neither can be set by a forging
    // site on the victim's browser, so either is safe to compare against.
    const sameHost = [
      single(req.headers.host),
      single(req.headers['x-forwarded-host']),
    ].some(
      (host) =>
        host !== undefined && host.toLowerCase() === originHost.toLowerCase(),
    );
    if (!sameHost && !extraOrigins.includes(origin)) refuse();
  }
}
