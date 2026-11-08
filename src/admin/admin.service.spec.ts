import { PrintableDocumentService } from '../orders/printable-document.service';
import { AdminService } from './admin.service';
import { SupabaseService } from '../supabase/supabase.service';
import { JwtService } from '@nestjs/jwt';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { TotpEncryptionService } from './totp-encryption.service';
import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import * as speakeasy from 'speakeasy';
import * as bcrypt from 'bcrypt';

function fixture(enabled = true) {
  const admin = {
    id: 'admin',
    email: 'admin@example.test',
    is_2fa_enabled: enabled,
    two_factor_secret_encrypted: 'encrypted-seed',
    password_hash: bcrypt.hashSync('password', 4),
  };
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: admin, error: null }),
  };
  const insert = jest.fn().mockResolvedValue({ error: null });
  const rpc = jest.fn().mockResolvedValue({ data: true, error: null });
  const sign = jest.fn().mockReturnValue('access-token');
  const secret = speakeasy.generateSecret().base32;
  const service = new AdminService(
    {
      getAdminClient: () => ({
        from: (table: string) => (table === 'admins' ? query : { insert }),
        rpc,
      }),
    } as unknown as SupabaseService,
    { sign } as unknown as JwtService,
    {} as DaemonDevicesService,
    { decrypt: () => secret } as unknown as TotpEncryptionService,
      {} as PrintableDocumentService,
  );
  return {
    service,
    rpc,
    sign,
    insert,
    token: () => speakeasy.totp({ secret, encoding: 'base32' }),
  };
}

describe('AdminService', () => {
  it('should be defined', () => {
    const service = new AdminService(
      {} as SupabaseService,
      {} as JwtService,
      {} as DaemonDevicesService,
      {} as TotpEncryptionService,
      {} as PrintableDocumentService,
    );
    expect(service).toBeDefined();
  });

  it('persists a hashed challenge before issuing a password-stage token', async () => {
    const { service, insert, sign } = fixture();
    await expect(
      service.login('admin@example.test', 'password'),
    ).resolves.toHaveProperty('requires_2fa', true);
    const payload = sign.mock.calls[0][0];
    expect(payload).toMatchObject({
      tokenType: 'admin-temp',
      jti: expect.any(String),
    });
    expect(insert.mock.calls[0][0]).toMatchObject({
      admin_id: 'admin',
      setup: false,
      token_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(insert.mock.calls[0][0].token_id_hash).not.toEqual(payload.jti);
  });

  it('fails closed if challenge persistence fails', async () => {
    const { service, insert, sign } = fixture();
    insert.mockResolvedValue({ error: { message: 'DB unavailable' } } as never);
    await expect(
      service.login('admin@example.test', 'password'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(sign).not.toHaveBeenCalled();
  });

  it('rejects consumed/locked challenges before verifying the OTP or issuing a session', async () => {
    const { service, rpc, sign, token } = fixture();
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(
      service.verify2FA('admin', token(), 'challenge'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sign).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects setup for an already enrolled administrator', async () => {
    const { service, rpc, sign, token } = fixture();
    await expect(
      service.setup2FA('admin', token(), 'challenge'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sign).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('returns no access token when atomic OTP/session consumption fails', async () => {
    const { service, rpc, token } = fixture();
    rpc
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: false, error: null });
    await expect(
      service.verify2FA('admin', token(), 'challenge'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(rpc).toHaveBeenLastCalledWith(
      'complete_admin_2fa',
      expect.objectContaining({
        p_setup: false,
        p_expected_secret: 'encrypted-seed',
        p_totp_step: expect.any(Number),
      }),
    );
  });

  it('cannot consume a challenge when JWT signing fails', async () => {
    const { service, rpc, sign, token } = fixture();
    sign.mockImplementation(() => {
      throw new Error('Signing failed');
    });
    await expect(
      service.verify2FA('admin', token(), 'challenge'),
    ).rejects.toThrow('Signing failed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
