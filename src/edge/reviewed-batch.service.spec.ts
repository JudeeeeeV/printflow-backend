import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReviewedBatchService } from './reviewed-batch.service';
import { ShopQueueService, type QueueRow } from '../orders/shop-queue.service';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintAssetService } from './print-asset.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import type { PrintAttemptRow } from '../orders/print-fulfillment';

const TOKEN = '00000000-0000-4000-8000-000000000001';
const REQUEST = '00000000-0000-4000-8000-000000000002';
const row = (id: string): QueueRow => ({
  id,
  state: 'IN_PRODUCTION',
  order_name: id,
  client_name: 'Ana',
  paper_size: 'A4',
  print_color_mode: 'BLACK_AND_WHITE',
  orientation: 'PORTRAIT',
  page_count: 2,
  copies: 3,
  payment_method: 'CASH_ON_PICKUP',
  payment_status: 'DUE_AT_PICKUP',
  acceptance_status: 'ACCEPTED',
  fingerprint: 'a'.repeat(32),
  source_path: `private/${id}.pdf`,
  has_document: true,
  selectable: true,
  blocking_reasons: [],
  available_actions: ['review'],
  raw_attempt: null,
  assets: [{ original_filename: `${id}.docx` }],
});
const attempt = (id: string): PrintAttemptRow =>
  ({
    attempt_id: `attempt-${id}`,
    order_id: id,
    shop_id: 'shop',
    status: 'QUEUED',
    attempt_number: 1,
    attempt_kind: 'INITIAL',
    execution_mode: 'AGENT',
    updated_at: new Date().toISOString(),
    printable_path: `private/${id}.pdf`,
    resolved_at: null,
  }) as PrintAttemptRow;

function fixture() {
  let rows = [row('one'), row('two')];
  let review: Record<string, unknown> | null = null;
  let durable: PrintAttemptRow[] = [];
  const queue = {
    requireShop: jest.fn().mockResolvedValue(undefined),
    items: jest.fn(() => Promise.resolve(rows)),
  };
  const gateway = {
    getConnectedAgent: jest
      .fn()
      .mockReturnValue({ deviceId: 'device', supportsAttempts: true }),
    hasConnectedDaemon: jest.fn().mockReturnValue(true),
    getAvailablePrinters: jest.fn().mockReturnValue(['Desk']),
    buildCommand: jest.fn().mockResolvedValue({}),
    emitPrintCommands: jest.fn().mockReturnValue(true),
    broadcastAttempt: jest.fn(),
  };
  const files = {
    preparePinned: jest.fn().mockResolvedValue({
      path: 'pinned.pdf',
      sha256: 'f'.repeat(64),
      size: 123,
    }),
    sign: jest.fn().mockResolvedValue('signed-file'),
  };
  const jobs = {
    beginBatchRequest: jest.fn().mockResolvedValue({ state: 'NEW' }),
    completeBatchRequest: jest.fn().mockResolvedValue(true),
    findAttempts: jest.fn(() => Promise.resolve(durable)),
    markUndelivered: jest.fn().mockResolvedValue(0),
  };
  const rpc = jest.fn((name: string) => {
    if (name === 'print_claim_reviewed_batch') {
      durable = [attempt('two'), attempt('one')];
      return Promise.resolve({
        data: { ok: true, attempts: durable },
        error: null,
      });
    }
    return Promise.resolve({ data: true, error: null });
  });
  const from = jest.fn((table: string) => {
    const chain: Record<string, jest.Mock> = {
      insert: jest.fn((value: Record<string, unknown>) => {
        review = {
          ...value,
          token: TOKEN,
          expires_at: new Date(Date.now() + 600000).toISOString(),
        };
        return chain;
      }),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: review, error: null })),
      maybeSingle: jest.fn(() =>
        Promise.resolve({
          data:
            table === 'print_batch_reviews'
              ? review
              : { status: 'PENDING', response: null },
          error: null,
        }),
      ),
      order: jest.fn(() => Promise.resolve({ data: durable, error: null })),
    };
    return chain;
  });
  const supabase = {
    getAdminClient: () => ({ from, rpc }),
    storagePath: (path: string) => path,
  };
  const service = new ReviewedBatchService(
    queue as unknown as ShopQueueService,
    supabase as unknown as SupabaseService,
    files as unknown as PrintAssetService,
    jobs as unknown as PrintJobsRepository,
    gateway as unknown as EdgeDaemonGateway,
  );
  const preview = (ids = ['two', 'one'], mode: 'AGENT' | 'MANUAL' = 'AGENT') =>
    service.preview('shop', 'shop', {
      orders: ids.map((orderId) => ({ orderId, fingerprint: 'a'.repeat(32) })),
      mode,
      printerName: mode === 'AGENT' ? 'Desk' : undefined,
    });
  const execute = () =>
    service.execute({
      shopId: 'shop',
      actorId: 'shop',
      orderIds: ['two', 'one'],
      reviewToken: TOKEN,
      requestId: REQUEST,
      mode: 'AGENT',
      printerName: 'Desk',
    });
  return {
    service,
    queue,
    gateway,
    files,
    jobs,
    rpc,
    from,
    preview,
    execute,
    setRows: (value: QueueRow[]) => {
      rows = value;
    },
    setReview: (value: Record<string, unknown> | null) => {
      review = value;
    },
    getReview: () => review!,
    setDurable: (value: PrintAttemptRow[]) => {
      durable = value;
    },
  };
}

describe('Reviewed batches', () => {
  it('previews every hidden selection in its selected order without creating attempts', async () => {
    const f = fixture();
    const result = await f.preview();
    expect(result.orders.map((order) => order.id)).toEqual(['two', 'one']);
    expect(result.totalPrintedPages).toBe(12);
    expect(result.reviewToken).toBe(TOKEN);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private/');
  });
  it('blocks mixed paper sizes, stale fingerprints and unavailable orders', async () => {
    const f = fixture();
    f.setRows([
      { ...row('one'), paper_size: 'LONG' },
      { ...row('two'), fingerprint: 'b'.repeat(32) },
    ]);
    const result = await f.preview();
    expect(result.reviewToken).toBeNull();
    expect(result.blockers.length).toBe(1);
    expect(result.orders[0].blocking_reasons).toContain(
      'Order details changed since selection. Refresh and review again.',
    );
    f.setRows([]);
    const missing = await f.preview();
    expect(missing.reviewToken).toBeNull();
    expect(missing.orders[0]).toEqual({
      id: 'two',
      selectable: false,
      blocking_reasons: ['Order unavailable for this shop.'],
    });
  });
  it('rejects duplicate selections and more than 25 items', async () => {
    const f = fixture();
    await expect(f.preview(['one', 'one'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      f.preview(Array.from({ length: 26 }, (_, i) => String(i))),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('keeps unreadable file errors on the affected row and prevents confirmation', async () => {
    const f = fixture();
    f.files.preparePinned.mockRejectedValue(new Error('Storage unavailable'));
    const result = await f.preview();
    expect(result.reviewToken).toBeNull();
    expect(result.orders[0].blocking_reasons).toHaveLength(1);
  });
  it('requires review data and shop authorization', async () => {
    const f = fixture();
    await expect(
      f.service.execute({
        shopId: 'shop',
        actorId: 'shop',
        orderIds: ['one'],
        mode: 'MANUAL',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.queue.requireShop.mockRejectedValue(new Error('Not verified'));
    await expect(f.execute()).rejects.toThrow('Not verified');
  });
  it('atomically claims all attempts and delivers them in reviewed order', async () => {
    const f = fixture();
    await f.preview();
    const result = await f.execute();
    expect(result.acceptedOrderIds).toEqual(['two', 'one']);
    expect(f.gateway.emitPrintCommands).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledWith('print_claim_reviewed_batch', {
      p_token: TOKEN,
      p_shop: 'shop',
      p_actor: 'shop',
      p_request: REQUEST,
    });
  });
  it('rejects a changed printer device before claiming', async () => {
    const f = fixture();
    await f.preview();
    f.gateway.getConnectedAgent.mockReturnValue({
      deviceId: 'replacement',
      supportsAttempts: true,
    });
    await expect(f.execute()).rejects.toBeInstanceOf(ConflictException);
    expect(
      f.rpc.mock.calls.some(
        ([name]: [string]) => name === 'print_claim_reviewed_batch',
      ),
    ).toBe(false);
  });
  it('rechecks actual file bytes before claiming', async () => {
    const f = fixture();
    await f.preview();
    f.files.preparePinned.mockResolvedValue({
      path: 'pinned.pdf',
      sha256: 'e'.repeat(64),
      size: 123,
    });
    await expect(f.execute()).rejects.toBeInstanceOf(ConflictException);
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });
  it('does not send any subset when the transactional claim reports a conflict', async () => {
    const f = fixture();
    await f.preview();
    f.rpc.mockImplementation(() =>
      Promise.resolve({
        data: {
          ok: false,
          code: 'BATCH_CHANGED',
          conflicts: [{ orderId: 'one' }],
        },
        error: null,
      }),
    );
    await expect(f.execute()).rejects.toBeInstanceOf(ConflictException);
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });
  it('replays recorded outcomes without dispatching again', async () => {
    const f = fixture();
    await f.preview();
    f.jobs.beginBatchRequest.mockResolvedValue({
      state: 'DONE',
      status: 'COMPLETED',
      response: { attempts: [], acceptedOrderIds: ['two', 'one'] },
    });
    expect((await f.execute()).replayed).toBe(true);
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });
  it('recovers accepted attempts from a pending request without resending commands', async () => {
    const f = fixture();
    f.setDurable([attempt('two'), attempt('one')]);
    const result = await f.service.recover('shop', REQUEST);
    expect(result.status).toBe('ACCEPTED');
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });
  it('keeps a manual batch accepted when download signing fails and recovers files without resending', async () => {
    const f = fixture();
    const manual = ['two', 'one'].map((id) => ({
      ...attempt(id),
      execution_mode: 'MANUAL' as const,
    }));
    f.setDurable(manual);
    f.files.sign.mockRejectedValue(
      new BadRequestException('Storage unavailable'),
    );
    const failedLinks = await f.service.recover('shop', REQUEST);
    expect(failedLinks.status).toBe('ACCEPTED');
    expect(failedLinks.result).toMatchObject({
      acceptedOrderIds: ['two', 'one'],
      downloads: [],
      downloadErrors: [{ orderId: 'two' }, { orderId: 'one' }],
    });
    f.files.sign.mockResolvedValue('fresh-signed-url');
    const recovered = await f.service.recover('shop', REQUEST);
    expect(recovered.result).toMatchObject({
      downloads: [
        { orderId: 'two', url: 'fresh-signed-url' },
        { orderId: 'one', url: 'fresh-signed-url' },
      ],
      downloadErrors: [],
    });
    expect(f.jobs.beginBatchRequest).not.toHaveBeenCalled();
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });
});
