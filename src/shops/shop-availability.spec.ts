import { isShopOpenNow, withEffectiveAvailability } from './shop-availability';

describe('shop availability', () => {
  const schedule = {
    availability_override: false,
    opens_at: '08:00',
    closes_at: '20:00',
    timezone: 'Asia/Manila',
  };

  it('opens during the scheduled window', () => {
    expect(isShopOpenNow(schedule, new Date('2026-10-06T04:00:00Z'))).toBe(
      true,
    );
  });

  it('closes at the end of the scheduled window', () => {
    expect(isShopOpenNow(schedule, new Date('2026-10-06T12:00:00Z'))).toBe(
      false,
    );
  });

  it('stays open after hours while the manual override is on', () => {
    expect(
      isShopOpenNow(
        { ...schedule, availability_override: true },
        new Date('2026-10-06T14:00:00Z'),
      ),
    ).toBe(true);
  });

  it('publishes the effective status', () => {
    expect(
      withEffectiveAvailability(schedule, new Date('2026-10-06T14:00:00Z'))
        .status,
    ).toBe('CLOSED');
  });
});
