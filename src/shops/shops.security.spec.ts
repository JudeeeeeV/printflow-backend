import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';
import { SupabaseService } from '../supabase/supabase.service';

// Exercise real HTTP routing, auth/role guards, validation, service filtering,
// and throttling. Only the external Supabase transport is replaced.
describe('Shop location API authorization', () => {
  let app: INestApplication;
  let rows: Record<string, Record<string, unknown>>;
  let writes: string[];
  const roles: Record<string, string> = {
    'shop-a': 'CLERK',
    'shop-b': 'MANAGER',
    student: 'STUDENT',
    'no-shop': 'CLERK',
  };

  beforeEach(async () => {
    rows = {
      'shop-a': { id: 'shop-a', name: 'Shop A', latitude: 10, longitude: 120 },
      'shop-b': { id: 'shop-b', name: 'Shop B', latitude: 11, longitude: 121 },
    };
    writes = [];
    const client = {
      auth: {
        getUser: jest.fn(async (token: string) => ({
          data: { user: roles[token] ? { id: token } : null },
          error: roles[token] ? null : new Error('Invalid session'),
        })),
      },
      from: (table: string) => {
        let id = '';
        let payload: Record<string, unknown> | undefined;
        const query = {
          select: () => query,
          eq: (_column: string, value: string) => {
            id = value;
            return query;
          },
          update: (body: Record<string, unknown>) => {
            payload = body;
            return query;
          },
          single: async () => {
            if (table === 'users')
              return { data: { role: roles[id] }, error: null };
            if (!rows[id]) return { data: null, error: { code: 'PGRST116' } };
            if (payload) {
              rows[id] = { ...rows[id], ...payload };
              writes.push(id);
            }
            return { data: rows[id], error: null };
          },
        };
        return query;
      },
    };
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }])],
      controllers: [ShopsController],
      providers: [
        ShopsService,
        {
          provide: SupabaseService,
          useValue: { getAdminClient: () => client },
        },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const pin = { latitude: 10.295, longitude: 123.88 };

  describe('GCash QR removal', () => {
    it.each([
      ['', 401],
      ['invalid', 401],
      ['student', 403],
    ] as const)('blocks removal for session %s', async (token, status) => {
      await request(app.getHttpServer())
        .delete('/shops/gcash-qr')
        .set('Authorization', `Bearer ${token}`)
        .expect(status);
      expect(writes).toEqual([]);
    });

    it.each(['shop-a', 'shop-b'])('clears only the authenticated shop %s', async (token) => {
      rows['shop-a'].gcash_qr_url = 'shop-a/qr.png';
      rows['shop-b'].gcash_qr_url = 'shop-b/qr.png';
      const other = token === 'shop-a' ? 'shop-b' : 'shop-a';
      await request(app.getHttpServer())
        .delete('/shops/gcash-qr')
        .set('Authorization', `Bearer ${token}`)
        .send({ shopId: other })
        .expect(200, { gcash_qr_url: null });
      expect(writes).toEqual([token]);
      expect(rows[token].gcash_qr_url).toBeNull();
      expect(rows[other].gcash_qr_url).toBe(`${other}/qr.png`);
    });

    it('returns 404 when the account has no shop', async () => {
      await request(app.getHttpServer())
        .delete('/shops/gcash-qr')
        .set('Authorization', 'Bearer no-shop')
        .expect(404);
      expect(writes).toEqual([]);
    });
  });

  describe('storefront photo upload', () => {
    let upload: jest.SpyInstance;
    const photo = Buffer.from('89504e470d0a1a0a', 'hex');

    beforeEach(() => {
      // Image decoding/storage are tested separately with actual image buffers.
      upload = jest
        .spyOn(app.get(ShopsService), 'uploadShopPhoto')
        .mockResolvedValue({
          shop_photo_url: 'https://example.test/photo.webp',
        });
    });

    it.each([
      ['', 401],
      ['invalid', 401],
      ['student', 403],
    ] as const)('blocks photo upload for session %s', async (token, status) => {
      await request(app.getHttpServer())
        .post('/shops/me/photo')
        .set('Authorization', `Bearer ${token}`)
        .attach('photo', photo, {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(status);
      expect(upload).not.toHaveBeenCalled();
    });

    it.each(['shop-a', 'shop-b'])(
      'binds photo upload to the authenticated shop %s',
      async (token) => {
        await request(app.getHttpServer())
          .post('/shops/me/photo')
          .set('Authorization', `Bearer ${token}`)
          .attach('photo', photo, {
            filename: 'photo.png',
            contentType: 'image/png',
          })
          .expect(201);
        expect(upload).toHaveBeenCalledWith(
          token,
          expect.objectContaining({ mimetype: 'image/png', buffer: photo }),
        );
      },
    );

    it('rejects shop IDs supplied in multipart fields', async () => {
      await request(app.getHttpServer())
        .post('/shops/me/photo')
        .set('Authorization', 'Bearer shop-a')
        .field('shopId', 'shop-b')
        .attach('photo', photo, {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(400);
      expect(upload).not.toHaveBeenCalled();
    });

    it('rejects a missing photo', async () => {
      await request(app.getHttpServer())
        .post('/shops/me/photo')
        .set('Authorization', 'Bearer shop-a')
        .expect(400);
      expect(upload).not.toHaveBeenCalled();
    });

    it('rejects SVG uploads', async () => {
      await request(app.getHttpServer())
        .post('/shops/me/photo')
        .set('Authorization', 'Bearer shop-a')
        .attach('photo', Buffer.from('<svg/>'), {
          filename: 'photo.svg',
          contentType: 'image/svg+xml',
        })
        .expect(400);
      expect(upload).not.toHaveBeenCalled();
    });

    it('rejects photos over 5 MB at the HTTP boundary', async () => {
      await request(app.getHttpServer())
        .post('/shops/me/photo')
        .set('Authorization', 'Bearer shop-a')
        .attach('photo', Buffer.alloc(5 * 1024 * 1024 + 1), {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(413);
      expect(upload).not.toHaveBeenCalled();
    });

    it('limits uploads to ten per hour', async () => {
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post('/shops/me/photo')
          .set('Authorization', 'Bearer shop-a')
          .attach('photo', photo, {
            filename: 'photo.png',
            contentType: 'image/png',
          })
          .expect(201);
      }
      await request(app.getHttpServer())
        .post('/shops/me/photo')
        .set('Authorization', 'Bearer shop-a')
        .attach('photo', photo, {
          filename: 'photo.png',
          contentType: 'image/png',
        })
        .expect(429);
      expect(upload).toHaveBeenCalledTimes(10);
    });

    it.each([
      { shop_photo_url: 'https://untrusted.example/image.svg' },
      { shop_photo_path: 'shop-b/photo.webp' },
    ])('rejects bypassing the upload endpoint with %j', async (payload) => {
      await request(app.getHttpServer())
        .patch('/shops/me')
        .set('Authorization', 'Bearer shop-a')
        .send(payload)
        .expect(400);
      expect(writes).toEqual([]);
    });
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).patch('/shops/me').send(pin).expect(401);
    expect(writes).toEqual([]);
  });

  it('rejects invalid sessions', async () => {
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer invalid')
      .send(pin)
      .expect(401);
    expect(writes).toEqual([]);
  });

  it('rejects students even when they send a forged shop role', async () => {
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer student')
      .send({ ...pin, role: 'CLERK' })
      .expect(403);
    expect(writes).toEqual([]);
  });

  it.each(['shop-a', 'shop-b'])(
    'saves only the signed-in shop for %s',
    async (id) => {
      await request(app.getHttpServer())
        .patch('/shops/me')
        .set('Cookie', `pf_user_access=${id}`)
        .send(pin)
        .expect(200);
      expect(writes).toEqual([id]);
      expect(rows[id]).toMatchObject(pin);
      const other = id === 'shop-a' ? 'shop-b' : 'shop-a';
      expect(rows[other].latitude).toBe(other === 'shop-a' ? 10 : 11);
    },
  );

  it.each([
    { id: 'shop-b' },
    { shopId: 'shop-b' },
    { verification_status: 'VERIFIED' },
    { role: 'MANAGER' },
  ])('rejects protected and foreign-shop fields: %j', async (extra) => {
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer shop-a')
      .send({ ...pin, ...extra })
      .expect(400);
    expect(writes).toEqual([]);
  });

  it('does not expose an endpoint for editing a supplied shop ID', async () => {
    await request(app.getHttpServer())
      .patch('/shops/shop-b')
      .set('Authorization', 'Bearer shop-a')
      .send(pin)
      .expect(404);
    expect(writes).toEqual([]);
  });

  it.each([
    { latitude: 91, longitude: 120 },
    { latitude: '10', longitude: 120 },
    { latitude: 10 },
    { latitude: null, longitude: 120 },
  ])('rejects invalid coordinate payloads: %j', async (body) => {
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer shop-a')
      .send(body)
      .expect(400);
    expect(writes).toEqual([]);
  });

  it('allows clearing a pin', async () => {
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer shop-a')
      .send({ latitude: null, longitude: null })
      .expect(200);
    expect(rows['shop-a']).toMatchObject({ latitude: null, longitude: null });
  });

  it('does not create a shop or edit another shop for an account without a shop', async () => {
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer no-shop')
      .send(pin)
      .expect(404);
    expect(writes).toEqual([]);
  });

  it('limits repeated saves to 20 per minute', async () => {
    for (let i = 0; i < 20; i++) {
      await request(app.getHttpServer())
        .patch('/shops/me')
        .set('Authorization', 'Bearer shop-a')
        .send(pin)
        .expect(200);
    }
    await request(app.getHttpServer())
      .patch('/shops/me')
      .set('Authorization', 'Bearer shop-a')
      .send(pin)
      .expect(429);
    expect(writes).toHaveLength(20);
  });
});
