export const DEFAULT_SHOP_TIMEZONE = 'Asia/Manila';

export interface ShopAvailability {
  availability_override?: boolean | null;
  opens_at?: string | null;
  closes_at?: string | null;
  timezone?: string | null;
}

const timeToMinutes = (value: string | null | undefined, fallback: number) => {
  const match = value?.match(/^(\d{2}):(\d{2})/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
    ? hours * 60 + minutes
    : fallback;
};

export function minutesInTimezone(
  date: Date,
  timezone = DEFAULT_SHOP_TIMEZONE,
): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function isShopOpenNow(
  shop: ShopAvailability,
  now = new Date(),
): boolean {
  if (shop.availability_override === true) return true;

  const opensAt = timeToMinutes(shop.opens_at, 8 * 60);
  const closesAt = timeToMinutes(shop.closes_at, 20 * 60);
  const current = minutesInTimezone(
    now,
    shop.timezone || DEFAULT_SHOP_TIMEZONE,
  );

  if (opensAt === closesAt) return false;
  if (opensAt < closesAt) return current >= opensAt && current < closesAt;
  return current >= opensAt || current < closesAt;
}

export function withEffectiveAvailability<T extends ShopAvailability>(
  shop: T,
  now = new Date(),
): T & { status: 'OPEN' | 'CLOSED'; is_open: boolean } {
  const isOpen = isShopOpenNow(shop, now);
  return { ...shop, status: isOpen ? 'OPEN' : 'CLOSED', is_open: isOpen };
}
