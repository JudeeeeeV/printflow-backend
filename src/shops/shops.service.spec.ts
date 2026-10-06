import { BadRequestException } from '@nestjs/common';
import { ShopsService } from './shops.service';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateShopDto } from './dto/update-shop.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('Shop locations', () => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    single: jest
      .fn()
      .mockResolvedValue({ data: { id: 'shop-1' }, error: null }),
  };
  const from = jest.fn(() => query);
  const service = new ShopsService({
    getAdminClient: () => ({ from }),
    createSignedStorageUrls: jest.fn().mockResolvedValue(new Map()),
  } as unknown as SupabaseService);

  beforeEach(() => jest.clearAllMocks());

  it('saves a complete pin and address only to the authenticated shop', async () => {
    await service.updateShop('shop-1', {
      location: ' Main entrance ',
      latitude: 0,
      longitude: 0,
    });
    expect(query.update).toHaveBeenCalledWith({
      location: 'Main entrance',
      latitude: 0,
      longitude: 0,
    });
    expect(query.eq).toHaveBeenCalledWith('id', 'shop-1');
  });

  it('allows removing both coordinates', async () => {
    await service.updateShop('shop-1', { latitude: null, longitude: null });
    expect(query.update).toHaveBeenCalledWith({
      latitude: null,
      longitude: null,
    });
  });

  it('preserves the pin on unrelated settings updates', async () => {
    await service.updateShop('shop-1', { name: 'Updated shop' });
    expect(query.update).toHaveBeenCalledWith({ name: 'Updated shop' });
  });

  it('saves the manual override and scheduled hours', async () => {
    await service.updateShop('shop-1', {
      availability_override: true,
      opens_at: '08:00',
      closes_at: '20:00',
    });
    expect(query.update).toHaveBeenCalledWith({
      availability_override: true,
      opens_at: '08:00',
      closes_at: '20:00',
    });
  });

  it('rejects a zero-length availability window', async () => {
    await expect(
      service.updateShop('shop-1', { opens_at: '08:00', closes_at: '08:00' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { latitude: 10 },
    { longitude: 120 },
    { latitude: null, longitude: 120 },
    { latitude: 91, longitude: 120 },
    { latitude: 10, longitude: -181 },
    { latitude: NaN, longitude: 120 },
    { latitude: 10, longitude: Infinity },
  ])('rejects invalid or incomplete coordinates: %j', async (payload) => {
    await expect(service.updateShop('shop-1', payload)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(query.update).not.toHaveBeenCalled();
  });

  it('lists approved shops with only public location and availability fields', async () => {
    await service.getVerifiedShops();
    expect(query.select).toHaveBeenCalledWith(
      'id, name, verification_status, pricing_matrix, location, latitude, longitude, shop_photo_path, availability_override, opens_at, closes_at, timezone',
    );
    expect(query.eq).toHaveBeenCalledWith('verification_status', 'VERIFIED');
  });

  it.each([
    { latitude: '10' },
    { longitude: 181 },
    { name: null },
    { location: 123 },
    { verification_status: 'VERIFIED' },
    { availability_override: 'true' },
    { opens_at: '8 AM' },
    { closes_at: '24:00' },
  ])('rejects malformed API fields: %j', async (body) => {
    const errors = await validate(plainToInstance(UpdateShopDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
