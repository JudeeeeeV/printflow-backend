import { OrdersModule } from '../orders/orders.module';
import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DaemonDevicesModule } from '../daemon-devices/daemon-devices.module';
import { TotpEncryptionService } from './totp-encryption.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { AdminTotpMigrationService } from './admin-totp-migration.service';

@Module({
  imports: [
    SupabaseModule,
    OrdersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret || secret.length < 32) {
          throw new Error(
            'JWT_SECRET must be configured with at least 32 characters',
          );
        }

        return {
          secret,
          signOptions: {
            algorithm: 'HS256' as const,
            issuer: 'printflow-api',
            audience: 'printflow-admin',
            expiresIn: '15m' as const,
          },
        };
      },
    }),
    DaemonDevicesModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    TotpEncryptionService,
    AdminAuditService,
    AdminAuditInterceptor,
    AdminTotpMigrationService,
  ],
  exports: [JwtModule],
})
export class AdminModule {}
