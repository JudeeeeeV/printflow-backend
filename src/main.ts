import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Use global validation pipes for DTOs
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Configure CORS securely
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173', // Your React Frontend URL
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
    allowedHeaders: 'Content-Type, Authorization',
  });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
