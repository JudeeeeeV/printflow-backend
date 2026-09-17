import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { TotpEncryptionService } from './totp-encryption.service';

interface AdminTotpRecord {
  id: string;
  two_factor_secret: string | null;
  two_factor_secret_encrypted: string | null;
}

@Injectable()
export class AdminTotpMigrationService implements OnModuleInit {
  private readonly logger = new Logger(AdminTotpMigrationService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly encryption: TotpEncryptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const client = this.supabase.getAdminClient();
    const { data, error } = await client
      .from('admins')
      .select('id, two_factor_secret, two_factor_secret_encrypted')
      .not('two_factor_secret', 'is', null);
    if (error) {
      throw new Error('Failed to inspect administrator 2FA encryption state');
    }

    const records = (data || []) as unknown as AdminTotpRecord[];
    for (const record of records) {
      if (!record.two_factor_secret) continue;
      const encrypted =
        record.two_factor_secret_encrypted ||
        this.encryption.encrypt(record.two_factor_secret);
      const { error: updateError } = await client
        .from('admins')
        .update({
          two_factor_secret: null,
          two_factor_secret_encrypted: encrypted,
        })
        .eq('id', record.id);
      if (updateError) {
        throw new Error('Failed to encrypt an administrator 2FA secret');
      }
    }

    if (records.length > 0) {
      this.logger.log(
        `Encrypted ${records.length} legacy administrator 2FA secret(s)`,
      );
    }
  }
}
