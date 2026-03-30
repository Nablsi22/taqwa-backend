import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers
  app.use(helmet());

  // ═══════════════════════════════════════════════════════════
  // INCREASE BODY SIZE LIMIT — fixes 413 for base64 images
  // ═══════════════════════════════════════════════════════════
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // CORS — allow Flutter app (web + mobile)
  app.enableCors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Validate all input
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Listen on all interfaces so mobile devices can connect
  await app.listen(3000, '0.0.0.0');
  console.log('Taqwa API running on http://0.0.0.0:3000');
}
bootstrap();