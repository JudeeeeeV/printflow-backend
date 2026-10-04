import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ShopsService } from './shops.service';
import { SupabaseService } from '../supabase/supabase.service';
import { OrdersService } from '../orders/orders.service';
import { PrintableDocumentService } from '../orders/printable-document.service';

describe('Shop GCash QR persistence', () => {
  const query = {
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    single: jest.fn(),
  };
  const bucket = { upload: jest.fn(), remove: jest.fn() };
  const from = jest.fn(() => query);
  const storageFrom = jest.fn(() => bucket);
  const sign = jest.fn();
  const service = new ShopsService({
    getAdminClient: () => ({ from, storage: { from: storageFrom } }),
    ensurePrivateBucket: jest.fn(),
    createSignedStorageUrl: sign,
  } as unknown as SupabaseService);
  const file = {
    mimetype: 'image/png',
    originalname: '../../other-shop/qr.png',
    buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
  } as Express.Multer.File;

  beforeEach(() => {
    jest.clearAllMocks();
    query.single.mockResolvedValue({ data: { id: 'shop-a' }, error: null });
    bucket.upload.mockResolvedValue({ error: null });
    sign.mockResolvedValue('https://example.test/signed-qr');
  });

  it('clears only the authenticated shop QR reference, preserving settings and stored objects', async () => {
    await expect(service.removeGcashQr('shop-a')).resolves.toEqual({
      gcash_qr_url: null,
    });
    expect(from).toHaveBeenCalledWith('shops');
    expect(query.update).toHaveBeenCalledWith({ gcash_qr_url: null });
    expect(query.eq).toHaveBeenCalledWith('id', 'shop-a');
    expect(storageFrom).not.toHaveBeenCalled();
  });

  it('allows repeated removal of an empty QR', async () => {
    await service.removeGcashQr('shop-a');
    await expect(service.removeGcashQr('shop-a')).resolves.toEqual({
      gcash_qr_url: null,
    });
  });

  it('reports removal database failures, including missing shops', async () => {
    query.single.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });
    await expect(service.removeGcashQr('shop-a')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('uploads under the authenticated shop and updates only its QR reference', async () => {
    await expect(service.uploadGcashQr('shop-a', file)).resolves.toMatchObject({
      gcash_qr_url: 'https://example.test/signed-qr',
    });
    expect(bucket.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^shop-a\/[a-f0-9-]+\.png$/),
      file.buffer,
      { contentType: 'image/png' },
    );
    expect(query.update).toHaveBeenCalledWith({
      gcash_qr_url: expect.stringMatching(
        /^shop-a\/[a-f0-9-]+\.png$/,
      ) as unknown,
    });
    expect(query.eq).toHaveBeenCalledWith('id', 'shop-a');
    expect(sign).toHaveBeenCalledWith(
      'gcash_qrs',
      expect.stringMatching(/^shop-a\/[a-f0-9-]+\.png$/),
      300,
    );
  });

  it('preserves the database reference on storage failure', async () => {
    bucket.upload.mockResolvedValue({
      error: { message: 'storage unavailable' },
    });
    await expect(service.uploadGcashQr('shop-a', file)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(query.update).not.toHaveBeenCalled();
  });

  it('reports upload database failures', async () => {
    query.single.mockResolvedValue({
      data: null,
      error: { message: 'database unavailable' },
    });
    await expect(service.uploadGcashQr('shop-a', file)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('rejects forged image contents before touching storage or the database', async () => {
    await expect(
      service.uploadGcashQr('shop-a', {
        ...file,
        buffer: Buffer.from('not an image'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storageFrom).not.toHaveBeenCalled();
    expect(query.update).not.toHaveBeenCalled();
  });
});

describe('Checkout GCash QR refresh', () => {
  it('reads the replacement or empty QR on the next order fetch', async () => {
    const shop = {
      name: 'Shop A',
      status: 'OPEN',
      gcash_qr_url: 'shop-a/old.png' as string | null,
    };
    const shopQuery = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn(() =>
        Promise.resolve({ data: { ...shop }, error: null }),
      ),
    };
    shopQuery.update.mockImplementation((patch: Partial<typeof shop>) => {
      Object.assign(shop, patch);
      return shopQuery;
    });
    const orderQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() =>
        Promise.resolve({
          data: { id: 'order-a', shops: { ...shop } },
          error: null,
        }),
      ),
    };
    const supabase = {
      getAdminClient: () => ({
        from: (table: string) => (table === 'shops' ? shopQuery : orderQuery),
        storage: {
          from: () => ({ upload: () => Promise.resolve({ error: null }) }),
        },
      }),
      ensurePrivateBucket: jest.fn(),
      createSignedStorageUrl: jest.fn((_bucket: string, path: string) =>
        Promise.resolve(`${path}/signed`),
      ),
    } as unknown as SupabaseService;
    const shops = new ShopsService(supabase);
    const orders = new OrdersService(supabase, {} as PrintableDocumentService);
    await expect(
      orders.getOrder('student-a', 'order-a'),
    ).resolves.toMatchObject({
      shops: { name: 'Shop A', gcash_qr_url: 'shop-a/old.png/signed' },
    });
    await shops.uploadGcashQr('shop-a', {
      mimetype: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    } as Express.Multer.File);
    await expect(
      orders.getOrder('student-a', 'order-a'),
    ).resolves.toMatchObject({
      shops: { name: 'Shop A', gcash_qr_url: `${shop.gcash_qr_url}/signed` },
    });
    await shops.removeGcashQr('shop-a');
    await expect(
      orders.getOrder('student-a', 'order-a'),
    ).resolves.toMatchObject({
      shops: { name: 'Shop A', gcash_qr_url: null },
    });
    expect(shop.status).toBe('OPEN');
    expect(orderQuery.eq).toHaveBeenCalledWith('client_id', 'student-a');
  });
});
