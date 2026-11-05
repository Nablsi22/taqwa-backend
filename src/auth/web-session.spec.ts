import { ForbiddenException } from '@nestjs/common';
import { ttlToSeconds } from './jwt-ttl.util';
import {
  assertTrustedWebRequest,
  parseCookies,
  readRefreshCookie,
  serializeClearedRefreshCookie,
  serializeRefreshCookie,
  WEB_REFRESH_COOKIE,
} from './web-session';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

describe('parseCookies', () => {
  it('parses pairs, trims, unquotes and keeps the first occurrence', () => {
    const cookies = parseCookies(' a=1; b="two" ; a=3; =x; c ');
    expect(cookies.get('a')).toBe('1');
    expect(cookies.get('b')).toBe('two');
    expect(cookies.has('c')).toBe(false);
    expect(cookies.size).toBe(2);
  });

  it('ignores oversized headers', () => {
    expect(parseCookies('a=' + 'x'.repeat(9000)).size).toBe(0);
  });
});

describe('readRefreshCookie', () => {
  it('returns only a JWT-shaped value from our cookie', () => {
    expect(readRefreshCookie(`${WEB_REFRESH_COOKIE}=${JWT}`)).toBe(JWT);
    expect(readRefreshCookie(`other=${JWT}`)).toBeUndefined();
    expect(
      readRefreshCookie(`${WEB_REFRESH_COOKIE}=not-a-jwt`),
    ).toBeUndefined();
    expect(readRefreshCookie(`${WEB_REFRESH_COOKIE}=a.b.c;d`)).toBe('a.b.c');
    expect(readRefreshCookie(undefined)).toBeUndefined();
  });
});

describe('refresh cookie attributes', () => {
  it('is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/', () => {
    const cookie = serializeRefreshCookie(JWT, 1209600.7);
    expect(cookie).toBe(
      `${WEB_REFRESH_COOKIE}=${JWT}; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Strict; Priority=High`,
    );
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('refuses to write anything but a JWT', () => {
    expect(() =>
      serializeRefreshCookie('x; Domain=evil.example', 10),
    ).toThrow();
  });

  it('clears with the same attributes', () => {
    expect(serializeClearedRefreshCookie()).toMatch(
      /^__Host-taqwa_rt=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
  });
});

describe('assertTrustedWebRequest', () => {
  const ok = {
    host: 'taqwa.up.railway.app',
    origin: 'https://taqwa.up.railway.app',
    'sec-fetch-site': 'same-origin',
    'x-taqwa-client': 'web',
  };
  const check =
    (headers: Record<string, string | undefined>, extra: string[] = []) =>
    () =>
      assertTrustedWebRequest({ headers }, extra);

  it('accepts the app itself', () => {
    expect(check(ok)).not.toThrow();
  });

  it('accepts an older browser that sends neither Origin nor Sec-Fetch-Site', () => {
    expect(check({ host: ok.host, 'x-taqwa-client': 'web' })).not.toThrow();
  });

  it.each([
    ['no client header', { ...ok, 'x-taqwa-client': undefined }],
    ['wrong client header', { ...ok, 'x-taqwa-client': 'mobile' }],
    ['cross-site fetch', { ...ok, 'sec-fetch-site': 'cross-site' }],
    ['same-site but other origin', { ...ok, 'sec-fetch-site': 'same-site' }],
    ['typed into the address bar', { ...ok, 'sec-fetch-site': 'none' }],
    ['foreign Origin', { ...ok, origin: 'https://evil.example' }],
    [
      'look-alike Origin',
      { ...ok, origin: 'https://taqwa.up.railway.app.evil.example' },
    ],
    ['opaque Origin', { ...ok, origin: 'null' }],
    ['garbage Origin', { ...ok, origin: '::::' }],
  ])('refuses %s', (_label, headers) => {
    expect(check(headers)).toThrow(ForbiddenException);
  });

  it('allows a listed development origin', () => {
    const dev = {
      host: 'localhost:3000',
      origin: 'http://localhost:5000',
      'sec-fetch-site': 'same-site',
      'x-taqwa-client': 'web',
    };
    expect(check(dev)).toThrow(ForbiddenException);
    expect(check(dev, ['http://localhost:5000'])).not.toThrow();
  });
});

describe('ttlToSeconds', () => {
  it.each([
    ['15m', 900],
    ['14d', 1_209_600],
    ['30 days', 2_592_000],
    ['2h', 7200],
    ['90', 90],
    ['1w', 604_800],
  ])('%s → %d', (ttl, seconds) => {
    expect(ttlToSeconds(ttl, '1d')).toBe(seconds);
  });

  it('uses the fallback when unset and rejects garbage', () => {
    expect(ttlToSeconds(undefined, '14d')).toBe(1_209_600);
    expect(() => ttlToSeconds('forever', '1d')).toThrow();
  });
});
