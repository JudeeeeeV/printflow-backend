import { SupabaseService } from '../supabase/supabase.service';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';

describe('OrdersService.getShopOrders client names', () => {
  function fixture(
    orders: Record<string, unknown>[],
    profileError: unknown = null,
    attempts: Record<string, unknown>[] = [],
  ) {
    const shopQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest
        .fn()
        .mockResolvedValue({ data: { id: 'shop' }, error: null }),
    };
    const orderQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({
        data: orders.map((order) => ({ state: 'OPEN_INQUIRY', ...order })),
        error: null,
      }),
    };
    const profileQuery = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [
          { id: 'client', first_name: 'Maria Ana', last_name: 'De la Cruz' },
        ],
        error: profileError,
      }),
    };
    const attemptQuery = {
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: attempts, error: null }),
    };
    const from = jest.fn((table: string) => {
      if (table === 'shops') return shopQuery;
      if (table === 'orders') return orderQuery;
      if (table === 'users') return profileQuery;
      if (table === 'print_jobs') return attemptQuery;
      throw new Error(`Unexpected table: ${table}`);
    });
    const sign = jest
      .fn()
      .mockResolvedValue(new Map([['asset-path', 'signed-url']]));
    const service = new OrdersService(
      {
        getAdminClient: () => ({ from }),
        createSignedStorageUrls: sign,
      } as unknown as SupabaseService,
      {} as PrintableDocumentService,
    );
    return {
      service,
      from,
      shopQuery,
      orderQuery,
      profileQuery,
      attemptQuery,
      sign,
    };
  }

  it('includes the latest persisted attempt without storage paths', async () => {
    const base = {
      order_id: 'printing',
      shop_id: 'shop',
      attempt_kind: 'INITIAL',
      execution_mode: 'AGENT',
      device_id: 'device',
      printer_name: 'Desk',
      printable_path: 'print-ready/secret.pdf',
      printable_sha256: 'a'.repeat(64),
      resolved_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const f = fixture(
      [{ id: 'printing', state: 'IN_PRODUCTION', client_id: 'client' }],
      null,
      [
        {
          ...base,
          attempt_id: 'second',
          attempt_number: 2,
          status: 'SUBMITTED',
        },
        {
          ...base,
          attempt_id: 'first',
          attempt_number: 1,
          status: 'FAILED_PRE_SUBMISSION',
        },
      ],
    );
    const [order] = await f.service.getShopOrders('shop');
    expect(f.attemptQuery.in).toHaveBeenCalledWith('order_id', ['printing']);
    expect(f.attemptQuery.eq).toHaveBeenCalledWith('shop_id', 'shop');
    expect(order.attempt_count).toBe(2);
    expect(order.current_attempt).toMatchObject({
      attemptId: 'second',
      attemptNumber: 2,
      status: 'SUBMITTED',
      printerName: 'Desk',
      isStale: false,
    });
    expect(JSON.stringify(order.current_attempt)).not.toContain('secret');
  });

  it('returns names and signed assets while fetching only clients from the shop orders', async () => {
    const f = fixture([
      {
        id: 'order1',
        client_id: 'client',
        assets: [{ file_url: 'asset-path' }],
      },
      { id: 'order2', client_id: 'client' },
      { id: 'order3', client_id: 'legacy' },
    ]);
    const result = await f.service.getShopOrders('shop');
    expect(f.orderQuery.eq).toHaveBeenCalledWith('shop_id', 'shop');
    expect(f.orderQuery.neq).toHaveBeenCalledWith('state', 'DRAFT');
    expect(f.profileQuery.select).toHaveBeenCalledWith(
      'id, first_name, last_name',
    );
    expect(f.profileQuery.in).toHaveBeenCalledWith('id', ['client', 'legacy']);
    expect(result[0].client_name).toBe('Maria Ana De la Cruz');
    expect(result[0].assets[0].file_url).toBe('signed-url');
    expect(result[1].client_name).toBe('Maria Ana De la Cruz');
    expect(result[2].client_name).toBeNull();
  });

  it('does not query profiles when the shop has no orders', async () => {
    const f = fixture([]);
    expect(await f.service.getShopOrders('shop')).toEqual([]);
    expect(f.from).not.toHaveBeenCalledWith('users');
  });

  it('filters drafts and unrecognized states before signing or querying their owners', async () => {
    const f = fixture([
      {
        id: 'draft',
        state: 'DRAFT',
        client_id: 'private-client',
        assets: [{ file_url: 'private-file' }],
      },
      {
        id: 'future',
        state: 'FUTURE_PRIVATE_STATE',
        client_id: 'private-client',
        assets: [{ file_url: 'future-file' }],
      },
      {
        id: 'submitted',
        state: 'IN_PRODUCTION',
        client_id: 'client',
        assets: [{ file_url: 'asset-path' }],
      },
    ]);
    const result = await f.service.getShopOrders('shop');
    expect(result.map((order) => order.id)).toEqual(['submitted']);
    expect(f.profileQuery.in).toHaveBeenCalledWith('id', ['client']);
    expect(f.sign).toHaveBeenCalledWith('assets', ['asset-path']);
    expect(f.sign).not.toHaveBeenCalledWith(
      'assets',
      expect.arrayContaining(['private-file']),
    );
  });

  it('rejects an unverified shop before reading orders or names', async () => {
    const f = fixture([]);
    f.shopQuery.single.mockResolvedValue({ data: null, error: null });
    await expect(f.service.getShopOrders('shop')).rejects.toThrow(
      'A verified shop account is required',
    );
    expect(f.from).not.toHaveBeenCalledWith('orders');
    expect(f.from).not.toHaveBeenCalledWith('users');
  });

  it('reports profile query failures instead of silently losing all names', async () => {
    const f = fixture([{ id: 'order', client_id: 'client' }], {
      message: 'unavailable',
    });
    await expect(f.service.getShopOrders('shop')).rejects.toThrow(
      'Failed to fetch client names.',
    );
  });
});

describe('OrdersService.getDrafts', () => {
  it.each([
    ['Lesson notes.docx', 'Lesson notes.docx'],
    [null, null],
  ])(
    'returns original filename %s while preserving the PDF path',
    async (originalName, expectedName) => {
      const storedPath = 'client/order/document.pdf';
      const signedUrl =
        'https://example.test/storage/v1/object/sign/assets/client/order/document.pdf?token=example';
      const query = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({
          data: [
            {
              id: 'order',
              total: 15,
              created_at: '2026-09-24T00:00:00.000Z',
              shop_id: 'shop',
              shops: { name: 'Print Shop' },
              assets: [
                { file_url: storedPath, original_filename: originalName },
              ],
              paper_size: 'A4',
              print_color_mode: 'BLACK_AND_WHITE',
              page_count: 1,
            },
          ],
          error: null,
          count: 1,
        }),
      };
      const info = jest.fn().mockResolvedValue({
        data: { metadata: null },
        error: null,
      });
      const supabaseService = {
        getAdminClient: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue(query),
          storage: { from: jest.fn().mockReturnValue({ info }) },
        }),
        storagePath: jest.fn().mockReturnValue(storedPath),
        createSignedStorageUrl: jest.fn().mockResolvedValue(signedUrl),
      };
      const service = new OrdersService(
        supabaseService as unknown as SupabaseService,
        {} as PrintableDocumentService,
      );

      const result = await service.getDrafts('client');

      expect(supabaseService.storagePath).toHaveBeenCalledWith(
        storedPath,
        'assets',
      );
      expect(result.data[0].fileName).toBe('document.pdf');
      expect(result.data[0].originalFileName).toBe(expectedName);
      expect(result.data[0].fileUrl).toBe(signedUrl);
      expect(info).toHaveBeenCalledTimes(originalName ? 0 : 1);
    },
  );

  it.each(['metadata', 'userMetadata'])(
    'reads %s when the original-name column is unavailable',
    async (metadataField) => {
      const storedPath = 'client/order/document.pdf';
      const query = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest
          .fn()
          .mockResolvedValueOnce({
            data: null,
            error: {
              code: '42703',
              message: 'column assets.original_filename does not exist',
            },
            count: null,
          })
          .mockResolvedValueOnce({
            data: [
              {
                id: 'order',
                total: 15,
                created_at: '2026-09-24T00:00:00.000Z',
                shop_id: 'shop',
                shops: { name: 'Print Shop' },
                assets: [{ file_url: storedPath }],
                paper_size: 'A4',
                print_color_mode: 'BLACK_AND_WHITE',
                page_count: 1,
              },
            ],
            error: null,
            count: 1,
          }),
      };
      const info = jest.fn().mockResolvedValue({
        data: { [metadataField]: { originalFileName: 'Lesson notes.docx' } },
        error: null,
      });
      const supabaseService = {
        getAdminClient: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue(query),
          storage: { from: jest.fn().mockReturnValue({ info }) },
        }),
        storagePath: jest.fn().mockReturnValue(storedPath),
        createSignedStorageUrl: jest.fn().mockResolvedValue('signed-url'),
      };
      const service = new OrdersService(
        supabaseService as unknown as SupabaseService,
        {} as PrintableDocumentService,
      );

      const result = await service.getDrafts('client');

      expect(query.range).toHaveBeenCalledTimes(2);
      expect(query.select).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('assets(file_url)'),
        { count: 'exact' },
      );
      expect(info).toHaveBeenCalledWith(storedPath);
      expect(result.data[0].originalFileName).toBe('Lesson notes.docx');
      expect(result.data[0].fileName).toBe('document.pdf');
    },
  );

  it('does not retry unrelated draft query failures', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({
        data: null,
        error: { code: '42501', message: 'permission denied' },
        count: null,
      }),
    };
    const supabaseService = {
      getAdminClient: jest
        .fn()
        .mockReturnValue({ from: jest.fn().mockReturnValue(query) }),
    };
    const service = new OrdersService(
      supabaseService as unknown as SupabaseService,
      {} as PrintableDocumentService,
    );

    await expect(service.getDrafts('client')).rejects.toThrow(
      'Failed to fetch drafts: permission denied',
    );
    expect(query.range).toHaveBeenCalledTimes(1);
  });
});

describe('OrdersService.createOrder', () => {
  it('stores the uploaded filename separately from the printable PDF path', async () => {
    const shopsQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: {
          pricing_matrix: {
            paper_sizes: { A4: 3 },
            color_mode_multipliers: { BLACK_AND_WHITE: 0 },
          },
        },
        error: null,
      }),
    };
    const operationsQuery = {
      update: jest.fn().mockReturnThis(),
      match: jest.fn().mockResolvedValue({ error: null }),
    };
    const upload = jest.fn().mockResolvedValue({ error: null });
    const rpc = jest.fn((name: string) =>
      name === 'claim_order_operation'
        ? Promise.resolve({
            data: {
              outcome: 'claimed',
              generation: 1,
              plannedOrderId: 'order',
            },
            error: null,
          })
        : {
            abortSignal: () =>
              Promise.resolve({
                data: { result: { orderId: 'order' }, replacedPaths: [] },
                error: null,
                status: 200,
              }),
          },
    );
    const supabase = {
      rpc,
      from: jest.fn((table: string) =>
        table === 'shops' ? shopsQuery : operationsQuery,
      ),
      storage: { from: jest.fn().mockReturnValue({ upload }) },
    };
    const supabaseService = {
      getAdminClient: jest.fn().mockReturnValue(supabase),
      ensurePrivateBucket: jest.fn().mockResolvedValue(undefined),
    };
    const printableDocuments = {
      normalize: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-'),
        pageCount: 1,
      }),
    };
    const service = new OrdersService(
      supabaseService as unknown as SupabaseService,
      printableDocuments as unknown as PrintableDocumentService,
    );
    const file = {
      originalname: 'Lesson notes.docx',
      mimetype:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('504b0304', 'hex'),
    } as Express.Multer.File;

    await service.createOrder(
      'client',
      {
        shopId: 'shop',
        isDraft: 'true',
        paperSize: 'A4',
        printColorMode: 'BLACK_AND_WHITE',
        orderName: 'Lesson notes',
        orientation: 'PORTRAIT',
        copies: 2,
      },
      file,
    );

    const commitCall = rpc.mock.calls.find(
      ([name]) => name === 'commit_order_operation',
    ) as unknown as [string, { p_data: Record<string, unknown> }];
    expect(commitCall[1].p_data).toMatchObject({
      asset: { originalFilename: 'Lesson notes.docx', fileType: 'PDF' },
      order: {
        order_name: 'Lesson notes',
        orientation: 'PORTRAIT',
        copies: 2,
        total: 6,
      },
    });
    expect(printableDocuments.normalize).toHaveBeenCalledWith(
      file,
      'A4',
      'PORTRAIT',
    );
    const uploadCalls = upload.mock.calls as unknown as Array<
      [string, Buffer, { metadata?: { originalFileName?: string } }]
    >;
    expect(uploadCalls[0][2].metadata?.originalFileName).toBe(
      'Lesson notes.docx',
    );
  });
});
