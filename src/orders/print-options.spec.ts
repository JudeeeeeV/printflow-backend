import {
  BadRequestException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentUploadException } from '../common/document-upload-error';
import { MAX_DOCUMENT_BYTES } from '../common/upload-security';
import { PDFDocument } from 'pdf-lib';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';
import { PrintAssetService } from '../edge/print-asset.service';
import { SupabaseService } from '../supabase/supabase.service';

const options = {
  shopId: '12345678-1234-4234-8234-123456789abc',
  paperSize: 'A4',
  printColorMode: 'COLOR',
  orderName: 'Four pages',
  orientation: 'LANDSCAPE' as const,
  copies: 2,
};
const pricing = {
  paper_sizes: { A4: 3, SHORT: 2, LONG: 4 },
  color_mode_multipliers: { COLOR: 3, BLACK_AND_WHITE: 0 },
};

describe('print options validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  it.each([CreateOrderDto, UpdateDraftDto])(
    'accepts both orientations and boundary copies in %p',
    async (metatype) => {
      for (const orientation of ['PORTRAIT', 'LANDSCAPE'])
        for (const copies of [1, 2, 99]) {
          const result = (await pipe.transform(
            {
              ...options,
              orientation,
              copies: metatype === CreateOrderDto ? String(copies) : copies,
            },
            { type: 'body', metatype },
          )) as { copies: number; orientation: string };
          expect(result.copies).toBe(copies);
          expect(result.orientation).toBe(orientation);
        }
    },
  );
  it.each([CreateOrderDto, UpdateDraftDto])(
    'rejects invalid orientations and copy counts in %p',
    async (metatype) => {
      for (const copies of [0, -1, 100, 1.5, null, undefined, 'invalid']) {
        await expect(
          pipe.transform({ ...options, copies }, { type: 'body', metatype }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      for (const orientation of ['SIDEWAYS', 'portrait', null, undefined]) {
        await expect(
          pipe.transform(
            { ...options, orientation },
            { type: 'body', metatype },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    },
  );
});

interface FixtureQuery {
  select: () => FixtureQuery;
  eq: (key: string, value: unknown) => FixtureQuery;
  limit: () => FixtureQuery;
  order: () => FixtureQuery;
  insert: (value: Record<string, unknown>) => FixtureQuery;
  update: (value: Record<string, unknown>) => FixtureQuery;
  single: () => Promise<{ data: Record<string, unknown>; error: null }>;
  maybeSingle: () => Promise<{ data: { id: string }; error: null }>;
  range: () => Promise<{
    data: Array<Record<string, unknown>>;
    error: null;
    count: number;
  }>;
  then: (resolve: (value: { error: null }) => unknown) => Promise<unknown>;
}

async function fixture() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([400, 800]).drawText('Upright page');
  let assetBuffer = Buffer.from(await pdf.save());
  const file = {
    buffer: assetBuffer,
    mimetype: 'application/pdf',
    originalname: 'four.pdf',
  } as Express.Multer.File;
  const row: Record<string, unknown> = {
    id: 'order',
    state: 'DRAFT',
    draft_version: 0,
  };
  const asset = {
    file_url: 'stored.pdf',
    file_type: 'PDF',
    original_filename: 'four.pdf',
  };
  const upload = jest.fn((_path: string, buffer: Buffer) => {
    assetBuffer = buffer;
    return Promise.resolve({ error: null });
  });
  const writes: string[] = [];
  const queries: Array<{ table: string; filters: Array<[string, unknown]> }> =
    [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    queries.push({ table, filters });
    const query: FixtureQuery = {
      select: jest.fn(() => query),
      eq: jest.fn((key: string, value: unknown) => {
        filters.push([key, value]);
        return query;
      }),
      limit: jest.fn(() => query),
      order: jest.fn(() => query),
      insert: jest.fn((value: Record<string, unknown>) => {
        writes.push(table);
        if (table === 'orders') Object.assign(row, value);
        return query;
      }),
      update: jest.fn((value: Record<string, unknown>) => {
        writes.push(table);
        Object.assign(row, value);
        return query;
      }),
      single: jest.fn(() =>
        Promise.resolve({
          data:
            table === 'shops'
              ? {
                  id: options.shopId,
                  verification_status: 'VERIFIED',
                  availability_override: true,
                  pricing_matrix: pricing,
                }
              : table === 'assets'
                ? asset
                : { ...row },
          error: null,
        }),
      ),
      maybeSingle: jest.fn(() =>
        Promise.resolve({
          data: { id: 'order' },
          error: null,
        }),
      ),
      range: jest.fn(() =>
        Promise.resolve({
          data: [{ ...row, shops: { name: 'Shop' }, assets: [asset] }],
          error: null,
          count: 1,
        }),
      ),
      then: (resolve: (value: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  };
  const storage = {
    upload,
    download: jest.fn(() =>
      Promise.resolve({
        data: new Blob([new Uint8Array(assetBuffer)]),
        error: null,
      }),
    ),
  };
  const supabase = {
    getAdminClient: () => ({ from, storage: { from: () => storage } }),
    ensurePrivateBucket: () => Promise.resolve(),
    storagePath: (value: string) => value,
    createSignedStorageUrl: () =>
      Promise.resolve('https://example.test/preview.pdf'),
  } as unknown as SupabaseService;
  const documents = new PrintableDocumentService();
  return {
    service: new OrdersService(supabase, documents),
    printAssets: new PrintAssetService(supabase, documents),
    row,
    documents,
    asset,
    writes,
    file,
    upload,
    storage,
    queries,
  };
}

describe('orientation and copies through orders and drafts', () => {
  it.each(['true', 'false'])(
    'creates and prices a four-page order with isDraft=%s',
    async (isDraft) => {
      const f = await fixture();
      await f.service.createOrder('student', { ...options, isDraft }, f.file);
      expect(f.row).toMatchObject({
        orientation: 'LANDSCAPE',
        copies: 2,
        total: 48,
        page_count: 4,
        state: isDraft === 'true' ? 'DRAFT' : 'OPEN_INQUIRY',
      });
      const output = await PDFDocument.load(f.upload.mock.calls[0][1]);
      for (const page of output.getPages())
        expect(page.getSize()).toEqual({ width: 841.89, height: 595.28 });
    },
  );

  it('reopens and changes a draft without re-uploading, then prints the saved orientation', async () => {
    const f = await fixture();
    await f.service.createOrder(
      'student',
      { ...options, isDraft: 'true' },
      f.file,
    );
    const saved = await f.service.getDrafts('student');
    expect(saved.data[0]).toMatchObject({
      orientation: 'LANDSCAPE',
      copies: 2,
      total: 48,
      pageCount: 4,
    });
    await f.service.updateDraft('student', 'order', {
      ...options,
      orientation: 'PORTRAIT',
      copies: 3,
    });
    const reopened = await f.service.getDrafts('student');
    expect(reopened.data[0]).toMatchObject({
      orientation: 'PORTRAIT',
      copies: 3,
      total: 72,
      pageCount: 4,
    });
    await f.service.submitDraft('student', 'order');
    expect(f.row).toMatchObject({
      orientation: 'PORTRAIT',
      copies: 3,
      total: 72,
      page_count: 4,
      state: 'OPEN_INQUIRY',
    });
    expect(f.upload).toHaveBeenCalledTimes(1);
    await f.printAssets.prepare(
      'stored.pdf',
      'shop',
      'order',
      'A4',
      'PORTRAIT',
    );
    const printed = await PDFDocument.load(f.upload.mock.calls[1][1]);
    for (const page of printed.getPages())
      expect(page.getSize()).toEqual({ width: 595.28, height: 841.89 });
    expect(f.upload.mock.calls[1][0]).toEqual(
      expect.stringMatching(
        new RegExp(`^print-ready/shop/order-A4-PORTRAIT-[a-f0-9]{16}\\.pdf$`),
      ),
    );
    expect(
      f.queries
        .filter((q) => q.table === 'orders')
        .every(
          (q) =>
            q.filters.length === 0 ||
            q.filters.some(
              ([key, value]) => key === 'client_id' && value === 'student',
            ),
        ),
    ).toBe(true);
  });

  it('reprices a legacy draft using one copy when its saved copy count is missing', async () => {
    const f = await fixture();
    await f.service.createOrder(
      'student',
      { ...options, isDraft: 'true' },
      f.file,
    );
    delete f.row.copies;
    await f.service.submitDraft('student', 'order');
    expect(f.row.total).toBe(24);
  });
});

describe('document preparation persistence safety', () => {
  it.each([
    ['unsupported', 'text/html', Buffer.from('html'), 'UNSUPPORTED_FILE'],
    ['empty', 'application/pdf', Buffer.alloc(0), 'EMPTY_FILE'],
    [
      'oversized',
      'application/pdf',
      Buffer.alloc(MAX_DOCUMENT_BYTES + 1),
      'FILE_TOO_LARGE',
    ],
    [
      'signature mismatch',
      'application/pdf',
      Buffer.from('not PDF'),
      'UNREADABLE_FILE',
    ],
    [
      'broken PDF',
      'application/pdf',
      Buffer.from('%PDF-not readable'),
      'UNREADABLE_FILE',
    ],
  ])(
    'does not persist an order or asset for %s',
    async (_label, mimetype, buffer, code) => {
      const f = await fixture();
      const error = await f.service
        .createOrder('student', options, { ...f.file, mimetype, buffer })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DocumentUploadException);
      expect((error as DocumentUploadException).getResponse()).toMatchObject({
        code,
      });
      expect(f.writes).toEqual([]);
      expect(f.upload).not.toHaveBeenCalled();
    },
  );
  it('does not persist an order when conversion is unavailable', async () => {
    const f = await fixture();
    jest
      .spyOn(f.documents, 'normalize')
      .mockRejectedValueOnce(new ServiceUnavailableException('private'));
    await expect(
      f.service.createOrder('student', options, f.file),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CONVERSION_UNAVAILABLE',
      }) as unknown,
    });
    expect(f.writes).toEqual([]);
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('reports uncertainty when storage fails after order creation', async () => {
    const f = await fixture();
    f.upload.mockRejectedValueOnce(new Error('private storage path'));
    await expect(
      f.service.createOrder('student', options, f.file),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'UPLOAD_FAILED',
        nextStep: expect.stringContaining('may be incomplete') as unknown,
      }) as unknown,
    });
    expect(f.writes).toEqual(['orders']);
  });
  it.each(['missing', 'wrong type', 'download rejection', 'unreadable'])(
    'blocks submission of a %s saved draft file',
    async (kind) => {
      const f = await fixture();
      if (kind === 'missing') f.asset.file_url = '';
      if (kind === 'wrong type') f.asset.file_type = 'DOCX';
      if (kind === 'download rejection')
        f.storage.download.mockRejectedValueOnce(new Error('private upstream'));
      if (kind === 'unreadable')
        jest
          .spyOn(f.documents, 'getPdfPageCount')
          .mockRejectedValueOnce(new BadRequestException('private parser'));
      await expect(
        f.service.submitDraft('student', 'order'),
      ).rejects.toBeInstanceOf(DocumentUploadException);
      expect(f.row.state).toBe('DRAFT');
      expect(f.writes).toEqual([]);
      expect(
        f.queries.some(
          (q) =>
            q.table === 'orders' &&
            q.filters.some(
              ([key, value]) => key === 'client_id' && value === 'student',
            ),
        ),
      ).toBe(true);
    },
  );
  it('retains the submitted-order lock before reading its file', async () => {
    const f = await fixture();
    f.row.state = 'IN_PRODUCTION';
    await expect(
      f.service.submitDraft('student', 'order'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.storage.download).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
});
