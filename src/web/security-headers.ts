import helmet from 'helmet';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isApiPath, type WebAppConfig } from './web-config';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Security headers — one policy for the API, one for the web app.
 *
 * API (/api/…): JSON only, so the strictest possible CSP (`default-src
 * 'none'`), never framed, never cached by the browser or a proxy
 * (`Cache-Control: no-store`, OWASP REST Security Cheat Sheet). A handler
 * that serves public, cacheable content (Quran page images) overrides
 * Cache-Control itself.
 *
 * Web app (everything else): the Flutter page. Its CSP allows only what the
 * page really loads:
 *   script-src  'self'             main.dart.js, flutter.js, canvaskit.js and
 *                                  the Firebase JS SDK, which is vendored into
 *                                  the build (web/vendor/firebase) — no script
 *                                  from any other site, and no inline script
 *               'wasm-unsafe-eval' compiling canvaskit.wasm (not JS eval)
 *   style-src   'unsafe-inline'    the engine writes its own <style> tags;
 *                                  no script can run through this
 *   connect-src fonts.gstatic.com  Flutter's fallback fonts for glyphs the
 *                                  bundled fonts lack (font files only);
 *               Firebase Installations and FCM registration endpoints
 * Firebase is preloaded by web/flutter_bootstrap.js, so FlutterFire never
 * injects its inline loader script (which this CSP would refuse).
 *
 * Refs: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
 *       https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
 *       https://helmetjs.github.io/
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The only remote endpoints the vendored Firebase messaging SDK calls. */
export const FIREBASE_CONNECT_SOURCES: readonly string[] = [
  'https://firebaseinstallations.googleapis.com',
  'https://fcmregistrations.googleapis.com',
];

export const FALLBACK_FONT_SOURCE = 'https://fonts.gstatic.com';

export function webCspDirectives(): Record<string, string[]> {
  return {
    'default-src': ["'none'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:', FALLBACK_FONT_SOURCE],
    'connect-src': [
      "'self'",
      FALLBACK_FONT_SOURCE,
      ...FIREBASE_CONNECT_SOURCES,
    ],
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'media-src': ["'self'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
    'upgrade-insecure-requests': [],
  };
}

export function apiCspDirectives(): Record<string, string[]> {
  return {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
}

/** Browser features the app never uses are switched off for every page. */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'bluetooth=()',
  'browsing-topics=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'publickey-credentials-get=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/** Values shared by both policies (Helmet defaults, tightened). */
const commonHelmet = {
  crossOriginOpenerPolicy: { policy: 'same-origin' as const },
  crossOriginResourcePolicy: { policy: 'same-origin' as const },
  referrerPolicy: { policy: 'no-referrer' as const },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  xFrameOptions: { action: 'deny' as const },
};

export function securityHeaders(
  config: Pick<WebAppConfig, 'cspMode'>,
): RequestHandler {
  const api = helmet({
    ...commonHelmet,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: apiCspDirectives(),
    },
  });

  const web = helmet({
    ...commonHelmet,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: webCspDirectives(),
      reportOnly: config.cspMode === 'report-only',
    },
  });

  return (req: Request, res: Response, next: NextFunction) => {
    // Nothing on this server is meant for search engines.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);

    if (isApiPath(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      return api(req, res, next);
    }
    return web(req, res, next);
  };
}
