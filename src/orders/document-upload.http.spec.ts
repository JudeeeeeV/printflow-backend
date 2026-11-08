import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SupabaseService } from '../supabase/supabase.service';
import { GlobalExceptionFilter } from '../common/global-exception.filter';
import { DocumentUploadException } from '../common/document-upload-error';
import { MAX_DOCUMENT_BYTES } from '../common/upload-security';

describe('order document HTTP boundary', () => {
  let app: INestApplication;
  const createOrder = jest.fn();
  beforeAll(async () => {
    const query = {
      select: () => query,
      eq: () => query,
      single: () => Promise.resolve({ data: { role: 'STUDENT' }, error: null }),
    };
    const module = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        { provide: OrdersService, useValue: { createOrder } },
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: () => ({
              auth: {
                getUser: () =>
                  Promise.resolve({
                    data: { user: { id: 'student' } },
                    error: null,
                  }),
              },
              from: () => query,
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.use((req: { requestId?: string }, _res: unknown, next: () => void) => {
      req.requestId = 'document-test';
      next();
    });
    await app.init();
  });
  beforeEach(() => {
    createOrder.mockReset();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = () =>
    request(app.getHttpServer() as Server)
      .post('/orders')
      .set('Authorization', 'Bearer fixture')
      .field('shopId', '12345678-1234-4234-8234-123456789abc')
      .field('orderName', 'Test')
      .field('paperSize', 'A4')
      .field('printColorMode', 'COLOR')
      .field('orientation', 'PORTRAIT')
      .field('copies', '1');

  it('rejects unsupported multipart files before service execution', async () => {
    const response = await post().attach('file', Buffer.from('html'), {
      filename: 'file.html',
      contentType: 'text/html',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'UNSUPPORTED_FILE',
      field: 'file',
      requestId: 'document-test',
      nextStep: expect.any(String) as unknown,
    });
    expect(createOrder).not.toHaveBeenCalled();
  });
  it('enforces the upload limit when browser checks are bypassed', async () => {
    const response = await post().attach(
      'file',
      Buffer.alloc(MAX_DOCUMENT_BYTES + 1),
      { filename: 'large.pdf', contentType: 'application/pdf' },
    );
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      code: 'FILE_TOO_LARGE',
      requestId: 'document-test',
    });
    expect(createOrder).not.toHaveBeenCalled();
  });
  it('provides file guidance for a missing upload', async () => {
    const response = await post();
    expect(response.status).toBe(400);
    expect((response.body as { code?: string }).code).toBe('EMPTY_FILE');
    expect(createOrder).not.toHaveBeenCalled();
  });
  it('passes supported uploads through without changing success responses', async () => {
    createOrder.mockResolvedValue({
      orderId: 'created',
      state: 'OPEN_INQUIRY',
    });
    const response = await post().attach('file', Buffer.from('%PDF-fixture'), {
      filename: 'source.pdf',
      contentType: 'application/pdf',
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      orderId: 'created',
      state: 'OPEN_INQUIRY',
    });
    expect(createOrder).toHaveBeenCalledWith(
      'student',
      expect.objectContaining({ copies: 1 }),
      expect.objectContaining({ mimetype: 'application/pdf' }),
    );
  });
  it('retains the safe file contract for service validation failures', async () => {
    createOrder.mockRejectedValue(
      new DocumentUploadException('UNREADABLE_FILE'),
    );
    const response = await post().attach('file', Buffer.from('%PDF-broken'), {
      filename: 'bad.pdf',
      contentType: 'application/pdf',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'UNREADABLE_FILE',
      field: 'file',
      requestId: 'document-test',
    });
  });
  it('keeps authentication ahead of multipart processing', async () => {
    const response = await request(app.getHttpServer() as Server).post(
      '/orders',
    );
    expect(response.status).toBe(401);
    expect((response.body as { code?: string }).code).toBeUndefined();
    expect(createOrder).not.toHaveBeenCalled();
  });
});
