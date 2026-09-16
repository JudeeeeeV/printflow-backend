import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './supabase/supabase.module';
import { IamModule } from './iam/iam.module';
import { AuthModule } from './auth/auth.module';
import { ShopsModule } from './shops/shops.module';
import { OrdersModule } from './orders/orders.module';
import { AdminModule } from './admin/admin.module';
import { EdgeModule } from './edge/edge.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { DaemonDevicesModule } from './daemon-devices/daemon-devices.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => {
        const required = [
          'SUPABASE_URL',
          'SUPABASE_SERVICE_ROLE_KEY',
          'JWT_SECRET',
        ];
        if (config.NODE_ENV === 'production') {
          required.push('FRONTEND_URL', 'ADMIN_URL', 'AGENT_JWT_SECRET');
        }
        const missing = required.filter((key) => !config[key]);
        if (missing.length > 0) {
          throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`,
          );
        }
        if (String(config.JWT_SECRET).length < 32) {
          throw new Error('JWT_SECRET must contain at least 32 characters');
        }
        if (
          config.AGENT_JWT_SECRET &&
          String(config.AGENT_JWT_SECRET).length < 32
        ) {
          throw new Error(
            'AGENT_JWT_SECRET must contain at least 32 characters',
          );
        }
        for (const key of [
          'SUPABASE_URL',
          'FRONTEND_URL',
          'ADMIN_URL',
          'AGENT_WINDOWS_DOWNLOAD_URL',
        ]) {
          if (!config[key]) continue;
          let parsed: URL;
          try {
            parsed = new URL(String(config[key]));
          } catch {
            throw new Error(`${key} must be a valid absolute URL`);
          }
          if (
            config.NODE_ENV === 'production' &&
            parsed.protocol !== 'https:'
          ) {
            throw new Error(`${key} must use HTTPS in production`);
          }
        }
        const sha256 = (value: unknown) =>
          createHash('sha256').update(String(value)).digest('hex');
        if (
          sha256(config.JWT_SECRET) ===
          'e3e74909f94002ad6d619b74bfff99df88cbca4bf9140a4cd673ed0aea4047db'
        ) {
          throw new Error(
            'JWT_SECRET is a known compromised value and must be rotated',
          );
        }
        if (
          sha256(config.SUPABASE_SERVICE_ROLE_KEY) ===
          '52a2ec5839df19c6e7b4e0bcb51b750e72071a7f8194e5ee9ecf86b07c5be145'
        ) {
          throw new Error(
            'SUPABASE_SERVICE_ROLE_KEY is a known compromised value and must be rotated',
          );
        }
        return config;
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    SupabaseModule,
    IamModule,
    AuthModule,
    ShopsModule,
    OrdersModule,
    AdminModule,
    DaemonDevicesModule,
    EdgeModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
