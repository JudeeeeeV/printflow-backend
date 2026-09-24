import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import sharp from 'sharp';
import { ShopsService } from './shops.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('Shop photo storage', () => {
  let service: ShopsService;
  let input: Express.Multer.File;
  const oldPath = 'shop-a/old.webp';
  const bucket = { upload: jest.fn(), remove: jest.fn() };
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  const sign = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    query.single.mockResolvedValue({
      data: { id: 'shop-a', shop_photo_path: oldPath },
      error: null,
    });
    query.maybeSingle.mockResolvedValue({
      data: { id: 'shop-a' },
      error: null,
    });
    bucket.upload.mockResolvedValue({ error: null });
    bucket.remove.mockResolvedValue({ error: null });
    sign.mockResolvedValue('https://example.test/signed-photo');
    service = new ShopsService({
      getAdminClient: () => ({
        from: () => query,
        storage: { from: () => bucket },
      }),
      ensurePrivateBucket: jest.fn(),
      createSignedStorageUrl: sign,
    } as unknown as SupabaseService);
    input = {
      mimetype: 'image/png',
      originalname: '../../other-shop/evil.png',
      buffer: await sharp({
        create: { width: 4, height: 4, channels: 3, background: '#123456' },
      })
        .png()
        .toBuffer(),
    } as Express.Multer.File;
  });

  it('generates its own object name under the authenticated shop, then replaces the old photo', async () => {
    await expect(service.uploadShopPhoto('shop-a', input)).resolves.toEqual({
      shop_photo_url: 'https://example.test/signed-photo',
    });
    const [path, bytes, options] = bucket.upload.mock.calls[0];
    expect(path).toMatch(/^shop-a\/[a-f0-9-]+\.webp$/);
    expect((await sharp(bytes).metadata()).format).toBe('webp');
    expect(options).toMatchObject({ contentType: 'image/webp', upsert: false });
    expect(query.eq).toHaveBeenCalledWith('id', 'shop-a');
    expect(query.eq).toHaveBeenCalledWith('shop_photo_path', oldPath);
    expect(bucket.remove).toHaveBeenCalledWith([oldPath]);
    expect(sign).toHaveBeenCalledWith('shop_photos', path, 3600);
  });

  it('uses an IS NULL comparison for the first photo', async () => {
    query.single.mockResolvedValue({
      data: { id: 'shop-a', shop_photo_path: null },
      error: null,
    });
    await service.uploadShopPhoto('shop-a', input);
    expect(query.is).toHaveBeenCalledWith('shop_photo_path', null);
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it('cleans up the new object after a database error without deleting the old photo', async () => {
    query.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });
    await expect(
      service.uploadShopPhoto('shop-a', input),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(bucket.remove).toHaveBeenCalledWith([
      bucket.upload.mock.calls[0][0],
    ]);
    expect(bucket.remove).not.toHaveBeenCalledWith([oldPath]);
  });

  it('rejects racing replacements and deletes only the losing upload', async () => {
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      service.uploadShopPhoto('shop-a', input),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(bucket.remove).toHaveBeenCalledWith([
      bucket.upload.mock.calls[0][0],
    ]);
    expect(bucket.remove).not.toHaveBeenCalledWith([oldPath]);
  });

  it('preserves the existing record on storage failure', async () => {
    bucket.upload.mockResolvedValue({
      error: { message: 'storage unavailable' },
    });
    await expect(
      service.uploadShopPhoto('shop-a', input),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(query.update).not.toHaveBeenCalled();
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it('returns signed photo URLs, never storage paths, in the public shop listing', async () => {
    const listing = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      error: null,
      data: [
        { id: 'shop-a', name: 'Shop A', shop_photo_path: oldPath },
        { id: 'shop-b', name: 'Shop B', shop_photo_path: null },
        { id: 'shop-c', name: 'Shop C', shop_photo_path: oldPath },
      ],
    };
    const publicService = new ShopsService({
      getAdminClient: () => ({ from: () => listing }),
      createSignedStorageUrl: sign,
    } as unknown as SupabaseService);
    expect(await publicService.getVerifiedShops()).toEqual([
      {
        id: 'shop-a',
        name: 'Shop A',
        shop_photo_url: 'https://example.test/signed-photo',
      },
      { id: 'shop-b', name: 'Shop B', shop_photo_url: null },
      { id: 'shop-c', name: 'Shop C', shop_photo_url: null },
    ]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(listing.eq).toHaveBeenCalledWith('verification_status', 'VERIFIED');
    expect(listing.eq).toHaveBeenCalledWith('status', 'OPEN');
  });
});
