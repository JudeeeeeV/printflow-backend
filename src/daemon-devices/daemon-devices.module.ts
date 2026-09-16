import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SupabaseModule } from '../supabase/supabase.module';
import { DaemonDevicesController } from './daemon-devices.controller';
import { DaemonDevicesService } from './daemon-devices.service';
import { DeviceConnectionRegistry } from './device-connection.registry';
import { AgentReleasesController } from './agent-releases.controller';

@Module({
  imports: [
    SupabaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('AGENT_JWT_SECRET') ||
          config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256' as const,
          issuer: 'printflow-api',
          audience: 'printflow-daemon',
          expiresIn: '15m' as const,
        },
      }),
    }),
  ],
  controllers: [DaemonDevicesController, AgentReleasesController],
  providers: [DaemonDevicesService, DeviceConnectionRegistry],
  exports: [DaemonDevicesService, DeviceConnectionRegistry],
})
export class DaemonDevicesModule {}
