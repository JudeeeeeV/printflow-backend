import { isIP } from 'node:net';

export function configuredTrustProxy(
  value = process.env.TRUST_PROXY,
): false | number | string[] {
  if (!value || value === 'false' || value === '0') return false;
  if (/^[1-9]\d?$/.test(value)) return Number(value);
  const ranges = value.split(',').map((range) => range.trim());
  if (
    ranges.every((range) => {
      if (['loopback', 'linklocal', 'uniquelocal'].includes(range)) return true;
      const [address, prefix, extra] = range.split('/');
      const family = isIP(address);
      return (
        family !== 0 &&
        extra === undefined &&
        (prefix === undefined ||
          (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
      );
    })
  )
    return ranges;
  throw new Error(
    'TRUST_PROXY must be false, a trusted hop count, or explicit proxy IP ranges',
  );
}
