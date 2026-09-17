import { SupabaseService } from '../supabase/supabase.service';
import { AdminTotpMigrationService } from './admin-totp-migration.service';
import { TotpEncryptionService } from './totp-encryption.service';

describe('AdminTotpMigrationService', () => {
  it('encrypts legacy seeds and clears the plaintext value', async () => {
    const not = jest.fn().mockResolvedValue({
      data: [
        {
          id: 'admin-id',
          two_factor_secret: 'JBSWY3DPEHPK3PXP',
          two_factor_secret_encrypted: null,
        },
      ],
      error: null,
    });
    const select = jest.fn().mockReturnValue({ not });
    const eq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({ eq });
    const from = jest
      .fn()
      .mockReturnValueOnce({ select })
      .mockReturnValueOnce({ update });
    const encrypt = jest.fn().mockReturnValue('v1.encrypted-value');
    const service = new AdminTotpMigrationService(
      {
        getAdminClient: () => ({ from }),
      } as unknown as SupabaseService,
      { encrypt } as unknown as TotpEncryptionService,
    );

    await service.onModuleInit();

    expect(encrypt).toHaveBeenCalledWith('JBSWY3DPEHPK3PXP');
    expect(update).toHaveBeenCalledWith({
      two_factor_secret: null,
      two_factor_secret_encrypted: 'v1.encrypted-value',
    });
    expect(eq).toHaveBeenCalledWith('id', 'admin-id');
  });
});
