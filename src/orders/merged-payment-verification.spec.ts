import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PDFDocument } from 'pdf-lib';
import { AdminService } from '../admin/admin.service';
import { TotpEncryptionService } from '../admin/totp-encryption.service';
import { OrderDecisionUnavailableException } from '../common/order-decision-unavailable.exception';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { SupabaseService } from '../supabase/supabase.service';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';

const query = (data: Record<string, unknown> | null) => ({
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  single: jest.fn().mockResolvedValue({ data, error: null }),
});

function adminFixture(bytes = Buffer.from('invalid PDF')) {
  const owned = query({ id: 'order', state: 'OPEN_INQUIRY', shop_id: 'shop' });
  const shop = query({ id: 'shop' });
  const asset = query({ file_url: 'stored/document.pdf', file_type: 'PDF' });
  const order = {
    id: 'order',
    state: 'IN_PRODUCTION',
    payment_status: 'VERIFIED',
  };
  const rpc = jest.fn().mockReturnValue({
    abortSignal: jest
      .fn()
      .mockResolvedValue({ data: order, error: null, status: 200 }),
  });
  const download = jest.fn().mockResolvedValue({
    data: { arrayBuffer: async () => Uint8Array.from(bytes).buffer },
    error: null,
  });
  const supabase = {
    from: (table: string) => {
      if (table === 'orders') return owned;
      if (table === 'shops') return shop;
      if (table === 'assets') return asset;
      throw new Error('Unexpected table');
    },
    rpc,
    storage: { from: jest.fn().mockReturnValue({ download }) },
  };
  const documents = new PrintableDocumentService();
  const validate = jest.spyOn(documents, 'getPdfPageCount');
  const service = new AdminService(
    {
      getAdminClient: () => supabase,
      storagePath: () => 'stored/document.pdf',
    } as unknown as SupabaseService,
    {} as JwtService,
    {} as DaemonDevicesService,
    {} as TotpEncryptionService,
    documents,
  );
  return { service, owned, shop, asset, download, validate, rpc, order };
}

describe('merged admin payment verification', () => {
  it('validates the stored PDF and shop before recording the current disputed payment', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const f = adminFixture(Buffer.from(await pdf.save()));
    const result = await f.service.forceApproveOrder(
      'order',
      'admin',
      'current-receipt',
      true,
    );
    expect(f.shop.eq).toHaveBeenCalledWith('verification_status', 'VERIFIED');
    expect(f.download).toHaveBeenCalledWith('stored/document.pdf');
    expect(f.validate).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith('apply_order_decision', {
      p_order: 'order',
      p_actor: 'admin',
      p_actor_type: 'ADMIN',
      p_action: 'ADMIN_VERIFY',
      p_data: { receiptId: 'current-receipt', confirmed: true },
    });
    expect(result.order).toBe(f.order);
    expect(f.validate.mock.invocationCallOrder[0]).toBeLessThan(
      f.rpc.mock.invocationCallOrder[0],
    );
  });

  it('leaves payment under review when the stored PDF is invalid', async () => {
    const f = adminFixture();
    await expect(
      f.service.forceApproveOrder('order', 'admin', 'receipt', true),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each(['missing asset', 'missing storage object', 'non-PDF'])(
    'blocks verification for %s',
    async (problem) => {
      const f = adminFixture();
      if (problem === 'missing asset')
        f.asset.single.mockResolvedValue({ data: null, error: null });
      if (problem === 'missing storage object')
        f.download.mockResolvedValue({
          data: null,
          error: { message: 'Missing' },
        });
      if (problem === 'non-PDF')
        f.asset.single.mockResolvedValue({
          data: { file_url: 'image.png', file_type: 'PNG' },
          error: null,
        });
      await expect(
        f.service.forceApproveOrder('order', 'admin', 'receipt', true),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(f.rpc).not.toHaveBeenCalled();
    },
  );

  it('blocks an unverified shop before downloading the document or verifying payment', async () => {
    const f = adminFixture();
    f.shop.single.mockResolvedValue({ data: null, error: null });
    await expect(
      f.service.forceApproveOrder('order', 'admin', 'receipt', true),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each(['CANCELLED', 'REJECTED', 'EXPIRED'])(
    'keeps %s refund verification available without a shop or document',
    async (state) => {
      const f = adminFixture();
      f.owned.single.mockResolvedValue({
        data: { id: 'order', state, shop_id: 'shop' },
        error: null,
      });
      f.shop.single.mockResolvedValue({ data: null, error: null });
      f.asset.single.mockResolvedValue({ data: null, error: null });
      await f.service.forceApproveOrder('order', 'admin', 'receipt', true);
      expect(f.shop.single).not.toHaveBeenCalled();
      expect(f.download).not.toHaveBeenCalled();
      expect(f.rpc).toHaveBeenCalledTimes(1);
    },
  );
});

const receiptFile = {
  mimetype: 'image/png',
  buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
} as Express.Multer.File;

function uploadFixture(overrides: Record<string, unknown> = {}) {
  const owned = query({
    id: 'order',
    state: 'OPEN_INQUIRY',
    payment_method: 'GCASH',
    payment_status: 'UNPAID',
    expires_at: null,
    ...overrides,
  });
  const upload = jest.fn().mockResolvedValue({ error: null });
  const remove = jest.fn().mockResolvedValue({ error: null });
  const abortSignal = jest.fn().mockResolvedValue({
    data: {
      result: { state: 'OPEN_INQUIRY', order: { id: 'order' } },
      replacedPaths: [],
    },
    error: null,
    status: 200,
  });
  const rpc = jest.fn((name: string) =>
    name === 'claim_order_operation'
      ? Promise.resolve({
          data: {
            outcome: 'claimed',
            generation: 1,
            plannedOrderId: 'planned',
          },
          error: null,
        })
      : { abortSignal },
  );
  let staged: string | undefined;
  let failed = false;
  const operations: Record<string, unknown> = {
    update: jest.fn((values: { staged_path?: string; status?: string }) => {
      staged = values.staged_path ?? staged;
      failed = failed || values.status === 'FAILED';
      return operations;
    }),
    match: jest.fn(() => operations),
    select: jest.fn(() => operations),
    eq: jest.fn(() => operations),
    maybeSingle: jest.fn(() =>
      Promise.resolve({
        data: failed
          ? { staged_bucket: 'receipts', staged_path: staged }
          : { status: 'PROCESSING' },
        error: null,
      }),
    ),
    then: (resolve: (value: unknown) => void) => resolve({ error: null }),
  };
  const from = (table: string) =>
    table === 'order_operations' ? operations : owned;
  const service = new OrdersService(
    {
      getAdminClient: () => ({
        from,
        rpc,
        storage: { from: () => ({ upload, remove }) },
      }),
      ensurePrivateBucket: jest.fn().mockResolvedValue(undefined),
    } as unknown as SupabaseService,
    {} as PrintableDocumentService,
  );
  const submit = () =>
    service.submitPaymentReceipt('student', 'order', receiptFile, 'reference');
  return { submit, upload, remove, abortSignal, rpc };
}

describe('receipt upload rollback cleanup', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    { payment_method: 'CASH_ON_PICKUP' },
    { state: 'CANCELLED' },
    { payment_status: 'PENDING_VERIFICATION' },
    { expires_at: '2000-01-01T00:00:00.000Z' },
  ])('rejects an ineligible order before uploading: %j', async (overrides) => {
    const f = uploadFixture(overrides);
    await expect(f.submit()).rejects.toBeInstanceOf(ConflictException);
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.abortSignal).not.toHaveBeenCalled();
  });

  it.each([
    ['40001', ConflictException],
    ['23514', BadRequestException],
    ['42501', ForbiddenException],
    ['P0002', NotFoundException],
  ])(
    'removes only the newly uploaded object after definite database rejection %s',
    async (code, ErrorType) => {
      const f = uploadFixture();
      f.abortSignal.mockResolvedValue({
        data: null,
        error: { code, message: 'Decision rejected' },
        status: 400,
      });
      await expect(f.submit()).rejects.toBeInstanceOf(ErrorType);
      expect(f.upload).toHaveBeenCalledTimes(1);
      expect(f.remove).toHaveBeenCalledTimes(1);
      expect(f.remove).toHaveBeenCalledWith([f.upload.mock.calls[0][0]]);
    },
  );

  it('retains an uploaded receipt after successful commit', async () => {
    const f = uploadFixture();
    await f.submit();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('retains an uploaded receipt after an uncertain HTTP 500 response', async () => {
    const f = uploadFixture();
    f.abortSignal.mockResolvedValue({
      data: null,
      error: { message: 'Unknown outcome' },
      status: 500,
    });
    await expect(f.submit()).rejects.toBeInstanceOf(
      OrderDecisionUnavailableException,
    );
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('retains an uploaded receipt after a thrown connection failure', async () => {
    const f = uploadFixture();
    f.abortSignal.mockRejectedValue(new Error('Connection lost'));
    await expect(f.submit()).rejects.toBeInstanceOf(
      OrderDecisionUnavailableException,
    );
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('retains an uploaded receipt when the decision deadline expires', async () => {
    jest.useFakeTimers();
    const f = uploadFixture();
    f.abortSignal.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ data: null, error: { message: 'Aborted' }, status: 0 }),
          );
        }),
    );
    const rejected = expect(f.submit()).rejects.toBeInstanceOf(
      OrderDecisionUnavailableException,
    );
    await jest.advanceTimersByTimeAsync(15_001);
    await rejected;
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('retains an uploaded receipt when the service returns no usable decision', async () => {
    const f = uploadFixture();
    f.abortSignal.mockResolvedValue({ data: null, error: null, status: 200 });
    await expect(f.submit()).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each(['returned error', 'thrown error'])(
    'preserves the decision failure if cleanup has a %s',
    async (failure) => {
      const f = uploadFixture();
      f.abortSignal.mockResolvedValue({
        data: null,
        error: { code: '40001', message: 'Order changed' },
        status: 409,
      });
      if (failure === 'returned error')
        f.remove.mockResolvedValue({ error: { message: 'Cleanup failed' } });
      else f.remove.mockRejectedValue(new Error('Cleanup failed'));
      await expect(f.submit()).rejects.toThrow(
        'The order or receipt changed. Refresh and review it before trying again.',
      );
      expect(f.remove).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        'Could not remove a stranded submission file.',
      );
    },
  );
});
