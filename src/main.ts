// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import dns from 'node:dns';

// Force IPv4 globally for DNS resolution to prevent ENETUNREACH on platforms that lack IPv6 outbound
dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:5173',
      process.env.ADMIN_URL || 'http://localhost:3001',
    ],
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
