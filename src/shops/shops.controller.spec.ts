import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Server } from 'node:http';
import request from 'supertest';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('GCash QR endpoints', () => {
  let app: INestApplication;
  let server: Server;
  const service = {
    uploadGcashQr: jest.fn(),
    removeGcashQr: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service.uploadGcashQr.mockResolvedValue({ gcash_qr_url: 'signed-qr' });
    service.removeGcashQr.mockResolvedValue({ gcash_qr_url: null });
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ limit: 100, ttl: 60_000 }])],
      controllers: [ShopsController],
      providers: [
        { provide: ShopsService, useValue: service },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: () => ({
              auth: {
                getUser: (token: string) => ({
                  data: {
                    user: { id: token === 'shop-b' ? 'shop-b' : 'shop-a' },
                  },
                  error: null,
                }),
              },
              from: () => ({
                select: () => ({
                  eq: () => ({
                    single: () => ({
                      data: { role: currentRole },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          },
        },
      ],
    }).compile();
    currentRole = 'CLERK';
    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
  });

  let currentRole = 'CLERK';
  afterEach(async () => {
    await app.close();
  });

  const upload = () => request(server).post('/shops/gcash-qr');
  const remove = () => request(server).delete('/shops/gcash-qr');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');

  it('requires authentication for both mutations', async () => {
    await upload().attach('qrCode', png, 'qr.png').expect(401);
    await remove().expect(401);
    expect(service.uploadGcashQr).not.toHaveBeenCalled();
    expect(service.removeGcashQr).not.toHaveBeenCalled();
  });

  it('rejects students on both mutations', async () => {
    currentRole = 'STUDENT';
    await upload()
      .auth('shop-a', { type: 'bearer' })
      .attach('qrCode', png, 'qr.png')
      .expect(403);
    await remove().auth('shop-a', { type: 'bearer' }).expect(403);
    expect(service.uploadGcashQr).not.toHaveBeenCalled();
    expect(service.removeGcashQr).not.toHaveBeenCalled();
  });

  it.each(['CLERK', 'MANAGER'])(
    'allows %s to upload and remove only their own shop QR',
    async (role) => {
      currentRole = role;
      await upload()
        .auth('shop-b', { type: 'bearer' })
        .field('shopId', 'shop-a')
        .attach('qrCode', png, 'qr.png')
        .expect(201);
      await remove()
        .auth('shop-b', { type: 'bearer' })
        .send({ shopId: 'shop-a' })
        .expect(200, { gcash_qr_url: null });
      expect(service.uploadGcashQr).toHaveBeenCalledWith(
        'shop-b',
        expect.objectContaining({ buffer: png }),
      );
      expect(service.removeGcashQr).toHaveBeenCalledWith('shop-b');
    },
  );

  it('requires an image in the existing multipart field and enforces type and size', async () => {
    await upload().auth('shop-a', { type: 'bearer' }).expect(400);
    await upload()
      .auth('shop-a', { type: 'bearer' })
      .attach('qrCode', Buffer.from('gif'), 'qr.gif')
      .expect(400);
    await upload()
      .auth('shop-a', { type: 'bearer' })
      .attach('qrCode', Buffer.alloc(10 * 1024 * 1024 + 1), 'qr.png')
      .expect(413);
    expect(service.uploadGcashQr).not.toHaveBeenCalled();
  });

  it.each(['upload', 'remove'])(
    'limits %s to five requests per hour',
    async (mutation) => {
      for (let index = 0; index < 5; index++) {
        if (mutation === 'upload')
          await upload()
            .auth('shop-a', { type: 'bearer' })
            .attach('qrCode', png, 'qr.png')
            .expect(201);
        else await remove().auth('shop-a', { type: 'bearer' }).expect(200);
      }
      if (mutation === 'upload')
        await upload()
          .auth('shop-a', { type: 'bearer' })
          .attach('qrCode', png, 'qr.png')
          .expect(429);
      else await remove().auth('shop-a', { type: 'bearer' }).expect(429);
    },
  );
});
