import { AdminService } from './admin.service';
import { SupabaseService } from '../supabase/supabase.service';
import { JwtService } from '@nestjs/jwt';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { TotpEncryptionService } from './totp-encryption.service';

describe('AdminService', () => {
  it('should be defined', () => {
    const service = new AdminService(
      {} as SupabaseService,
      {} as JwtService,
      {} as DaemonDevicesService,
      {} as TotpEncryptionService,
    );
    expect(service).toBeDefined();
  });
});
