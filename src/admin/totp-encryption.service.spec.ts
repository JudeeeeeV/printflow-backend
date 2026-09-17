import { ConfigService } from '@nestjs/config';
import { TotpEncryptionService } from './totp-encryption.service';

describe('TotpEncryptionService', () => {
  const service = new TotpEncryptionService({
    get: jest.fn(() => 'test-encryption-key-with-at-least-32-characters'),
  } as unknown as ConfigService);

  it('encrypts and authenticates TOTP secrets', () => {
    const encrypted = service.encrypt('JBSWY3DPEHPK3PXP');

    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(service.decrypt(encrypted)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects a modified encrypted value', () => {
    const encrypted = service.encrypt('JBSWY3DPEHPK3PXP');
    const parts = encrypted.split('.');
    parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
    const tampered = parts.join('.');

    expect(() => service.decrypt(tampered)).toThrow();
  });
});
