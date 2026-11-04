import { isIP } from 'node:net';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The caller's own address, for rate limiting.
 *
 * Behind Railway's edge the socket peer is the edge proxy (100.0.0.0/8),
 * shared by many callers at once, so `req.ip` alone would make every user
 * of the mosque one "client" and spend one shared rate limit between them.
 * Measured on Railway: X-Forwarded-For reaches the app as
 * `<client>, <edge/CDN hop>` and the edge drops any value the caller sent
 * itself, so the leftmost entry is the caller. Anything unusable falls back
 * to the socket address — never worse than before.
 *
 * Ref: https://station.railway.com/questions/does-the-edge-strip-client-x-forwarded-f-613e5cb6
 *      https://expressjs.com/en/guide/behind-proxies.html
 *
 * Only rate limits key on this. Nothing that grants access ever trusts it,
 * and the per-account sign-in lock (LoginAttemptsService) does not depend
 * on any address at all.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface IpSource {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export function clientIp(req: IpSource): string {
  const raw = req.headers?.['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const first = header?.split(',')[0]?.trim();
  if (first && isIP(first)) return first;
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
