import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loadWebAppConfig } from './web/web-config';
import { securityHeaders } from './web/security-headers';
import { WebAssetStore, webAppHandler } from './web/web-app';
import { buildFirebaseConfigScript } from './web/firebase-web-config';
import { WEB_CLIENT_HEADER } from './auth/web-session';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const web = loadWebAppConfig();

  // ═══════════════════════════════════════════════════════════
  // SECURITY HEADERS — strict policy for /api, page policy for the web
  // app (src/web/security-headers.ts). Registered first so that every
  // response, errors included, carries them.
  // ═══════════════════════════════════════════════════════════
  app.disable('x-powered-by');
  app.use(securityHeaders(web));

  // ═══════════════════════════════════════════════════════════
  // INCREASE BODY SIZE LIMIT — fixes 413 for base64 images
  // ═══════════════════════════════════════════════════════════
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // ═══════════════════════════════════════════════════════════
  // CORS — the phone apps never need it (CORS is a browser rule) and the
  // web app is served from this same origin, so by default no other site
  // may call the API from a browser. CORS_ORIGINS opens exact origins for
  // local development only. Cookies are never shared cross-origin.
  // ═══════════════════════════════════════════════════════════
  for (const rejected of web.rejectedCorsOrigins) {
    logger.warn(`CORS_ORIGINS: ignored "${rejected}" (not an exact https origin)`);
  }
  if (web.corsOrigins.length > 0) {
    app.enableCors({
      origin: [...web.corsOrigins],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', WEB_CLIENT_HEADER],
      credentials: false,
      maxAge: 600,
    });
    logger.log(`CORS open to: ${web.corsOrigins.join(', ')}`);
  }

  // ═══════════════════════════════════════════════════════════
  // WEB APP — the Flutter web build (web-dist/), same origin as the API.
  // A missing or broken build never stops the API from starting.
  // ═══════════════════════════════════════════════════════════
  if (web.enabled) {
    try {
      const store = WebAssetStore.loadSync(web.distDir);
      const firebase = buildFirebaseConfigScript(process.env.FIREBASE_WEB_CONFIG);
      if (firebase.problem) {
        logger.warn(`Web push disabled: ${firebase.problem}`);
      }
      const dynamicAssets = new Map([
        [
          '/firebase-config.js',
          {
            type: 'text/javascript; charset=utf-8',
            body: Buffer.from(firebase.script, 'utf8'),
          },
        ],
      ]);
      app.use(webAppHandler(store, dynamicAssets));
      logger.log(
        `Web app: ${store.size} files from ${web.distDir} (CSP ${web.cspMode})`,
      );
      store
        .compressAll()
        .then(({ files, savedBytes }) =>
          logger.log(
            `Web app: compressed ${files} files, ${(savedBytes / 1048576).toFixed(1)} MB saved per full download`,
          ),
        )
        .catch((err: unknown) =>
          logger.error(`Web app: compression failed: ${String(err)}`),
        );
    } catch (err) {
      logger.error(`Web app NOT served: ${String(err)}`);
    }
  } else {
    logger.log(`Web app not served (WEB_APP=off or no ${web.distDir}/index.html)`);
  }

  // Validate all input
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Listen on all interfaces so mobile devices can connect
  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  console.log(`Taqwa API running on http://0.0.0.0:${port}`);
}
bootstrap();
