// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_TEMP_COOKIE,
  readCookie,
  USER_ACCESS_COOKIE,
  USER_REFRESH_COOKIE,
} from './auth/auth-cookies';
import { GlobalExceptionFilter } from './common/global-exception.filter';

// Force IPv4 globally for DNS resolution to prevent ENETUNREACH on platforms that lack IPv6 outbound
dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    process.env.ADMIN_URL || 'http://localhost:3001',
  ];

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts:
        process.env.NODE_ENV === 'production'
          ? { maxAge: 31_536_000, includeSubDomains: true }
          : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId =
      typeof request.headers['x-request-id'] === 'string' &&
      /^[A-Za-z0-9._-]{1,100}$/.test(request.headers['x-request-id'])
        ? request.headers['x-request-id']
        : randomUUID();
    (request as Request & { requestId?: string }).requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    const unsafeMethod = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const usesCookieAuthentication = [
      USER_ACCESS_COOKIE,
      USER_REFRESH_COOKIE,
      ADMIN_TEMP_COOKIE,
      ADMIN_ACCESS_COOKIE,
    ].some((name) => Boolean(readCookie(request, name)));
    const origin = request.headers.origin;
    const hasOrigin = typeof origin === 'string';
    if (
      unsafeMethod &&
      ((hasOrigin && !allowedOrigins.includes(origin)) ||
        (usesCookieAuthentication && !hasOrigin))
    ) {
      response.status(403).json({ message: 'Request origin is not allowed' });
      return;
    }
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Authorization',
  });

  const expressApp = app.getHttpAdapter().getInstance() as unknown as {
    disable(name: string): void;
    set(name: string, value: number): void;
  };
  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', 1);
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`PrintFlow Backend running on port ${port}`);
}
void bootstrap();
