import { configuredTrustProxy } from './trust-proxy';

describe('trusted proxy configuration', () => {
  it('ignores forwarded IPs on direct deployments', () => {
    for (const value of ['', '0', 'false'])
      expect(configuredTrustProxy(value)).toBe(false);
  });
  it('supports an explicit ingress count and IP ranges', () => {
    expect(configuredTrustProxy('1')).toBe(1);
    expect(configuredTrustProxy('127.0.0.1, 10.0.0.0/8, ::1/128')).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      '::1/128',
    ]);
  });
  it.each([
    'true',
    '-1',
    '100',
    '10.0.0.1/33',
    '::1/129',
    '127.0.0.1/8/extra',
    'invalid',
    ',',
  ])('rejects invalid or unrestricted trust: %s', (value) => {
    expect(() => configuredTrustProxy(value)).toThrow();
  });
});
