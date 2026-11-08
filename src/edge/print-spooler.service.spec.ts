import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { PrintSpoolerService } from './print-spooler.service';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintAssetService } from './print-asset.service';

const REQUEST = '33333333-3333-4333-8333-333333333333';

function attempt(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: `attempt-${orderId}`,
    order_id: orderId,
    shop_id: 'shop-1',
    status: 'QUEUED',
    attempt_number: 1,
    attempt_kind: 'INITIAL',
    execution_mode: 'AGENT',
    device_id: 'device-1',
    printer_name: 'Desk',
    print_settings: {
      colorMode: 'COLOR',
      paperSize: 'A4',
      orientation: 'LANDSCAPE',
      copies: 2,
    },
    printable_path: `print-ready/${orderId}.pdf`,
    printable_sha256: 'a'.repeat(64),
    printable_size: 100,
    revision_ref: 'document.pdf',
    resolved_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function setup() {
  const gateway = {
    hasConnectedDaemon: jest.fn().mockReturnValue(true),
    getConnectedAgent: jest
      .fn()
      .mockReturnValue({ deviceId: 'device-1', supportsAttempts: true }),
    getAvailablePrinters: jest.fn().mockReturnValue(['Desk']),
    emitPrintCommands: jest.fn().mockReturnValue(true),
    buildCommand: jest.fn((row: { attempt_id: string }) =>
      Promise.resolve({ attemptId: row.attempt_id }),
    ),
    broadcastAttempt: jest.fn(),
  };
  const jobs = {
    beginBatchRequest: jest.fn().mockResolvedValue({ state: 'NEW' }),
    completeBatchRequest: jest.fn().mockResolvedValue(true),
    createAttempt: jest.fn(
      (input: { orderId: string; mode: string; kind: string }) =>
        Promise.resolve({
          ok: true,
          attempt: attempt(input.orderId, {
            execution_mode: input.mode,
            attempt_kind: input.kind,
            status: input.mode === 'MANUAL' ? 'MANUAL_STARTED' : 'QUEUED',
          }),
        }),
    ),
    findOpenAttempts: jest.fn().mockResolvedValue([]),
    findAttempts: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids.map((id) =>
          attempt(id.replace('attempt-', ''), {
            status: 'FAILED_PRE_SUBMISSION',
          }),
        ),
      ),
    ),
    findAttempt: jest.fn(),
    markUndelivered: jest.fn().mockResolvedValue(1),
    recordReconciliationNote: jest.fn(),
  };
  const orders = [
    {
      id: 'order-1',
      state: 'IN_PRODUCTION',
      order_name: 'Thesis draft',
      print_color_mode: 'COLOR',
      paper_size: 'A4',
      orientation: 'LANDSCAPE',
      copies: 2,
      assets: [{ file_url: 'document.pdf' }],
    },
  ];
  const query: Record<string, jest.Mock> = {};
  query.select = jest.fn(() => query);
  query.eq = jest.fn(() => query);
  query.single = jest.fn().mockResolvedValue({ data: { id: 'shop-1' } });
  query.in = jest.fn().mockResolvedValue({ data: orders });
  const supabase = {
    getAdminClient: () => ({ from: () => query }),
    ensurePrivateBucket: jest.fn().mockResolvedValue(undefined),
    storagePath: (value: string) => value,
  };
  const printAssets = {
    preparePinned: jest.fn((asset: string, _shop: string, orderId: string) =>
      Promise.resolve({
        path: `print-ready/${orderId}.pdf`,
        sha256: 'a'.repeat(64),
        size: 100,
        asset,
      }),
    ),
    sign: jest.fn((path: string) => Promise.resolve(`https://signed/${path}`)),
  };
  const service = new PrintSpoolerService(
    gateway as unknown as EdgeDaemonGateway,
    jobs as unknown as PrintJobsRepository,
    supabase as unknown as SupabaseService,
    printAssets as unknown as PrintAssetService,
  );
  const run = (
    orderIds = ['order-1'],
    printerName: string | undefined = 'Desk',
  ) =>
    service.executeBatch({
      orderIds,
      shopId: 'shop-1',
      actorId: 'shop-1',
      printerName,
      requestId: REQUEST,
    });
  return { service, gateway, jobs, supabase, printAssets, query, orders, run };
}

describe('PrintSpoolerService batch dispatch', () => {
  it('does not record any attempts if preparing a later file fails', async () => {
    const f = setup();
    f.query.in.mockResolvedValue({
      data: ['one', 'two'].map((id) => ({
        ...f.orders[0],
        id,
        assets: [{ file_url: `${id}.png` }],
      })),
    });
    f.printAssets.preparePinned
      .mockResolvedValueOnce({
        path: 'one.pdf',
        sha256: 'a',
        size: 1,
        asset: '',
      })
      .mockRejectedValueOnce(new BadRequestException('Invalid file'));
    await expect(f.run(['one', 'two'])).rejects.toThrow('Invalid file');
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
    expect(f.jobs.completeBatchRequest).toHaveBeenCalledWith(
      REQUEST,
      'shop-1',
      'FAILED',
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('skips orders that already have an unresolved attempt', async () => {
    const f = setup();
    f.jobs.findOpenAttempts.mockResolvedValue([attempt('order-1')]);
    await expect(f.run()).rejects.toThrow(ConflictException);
    expect(f.printAssets.preparePinned).not.toHaveBeenCalled();
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });

  it('returns an actionable conflict for an offline agent without recording attempts', async () => {
    const f = setup();
    f.gateway.hasConnectedDaemon.mockReturnValue(false);
    await expect(f.run()).rejects.toThrow('offline');
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
    expect(f.supabase.ensurePrivateBucket).not.toHaveBeenCalled();
  });

  it('requires the updated reporting capability for automated dispatch', async () => {
    const f = setup();
    f.gateway.getConnectedAgent.mockReturnValue({
      deviceId: 'device-1',
      supportsAttempts: false,
    });
    const error = await f.run().catch((caught: HttpException) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'AGENT_UPDATE_REQUIRED',
    });
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
  });

  it('rejects sending while no printers have been reported', async () => {
    const f = setup();
    f.gateway.getAvailablePrinters.mockReturnValue([]);
    await expect(f.run(['order-1'], undefined)).rejects.toThrow(
      'has not reported any printers',
    );
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
  });

  it('rejects a printer removed since the dashboard last refreshed', async () => {
    const f = setup();
    await expect(f.run(['order-1'], 'Removed')).rejects.toThrow(
      BadRequestException,
    );
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
  });

  it('records a pinned attempt per order and delivers it to the assigned device', async () => {
    const f = setup();
    const result = await f.run();
    expect(f.printAssets.preparePinned).toHaveBeenCalledWith(
      'document.pdf',
      'shop-1',
      'order-1',
      'A4',
      'LANDSCAPE',
    );
    expect(f.jobs.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        kind: 'INITIAL',
        mode: 'AGENT',
        deviceId: 'device-1',
        printerName: 'Desk',
        revisionId: 'document.pdf',
        batchRequestId: REQUEST,
        printable: {
          path: 'print-ready/order-1.pdf',
          sha256: 'a'.repeat(64),
          size: 100,
          asset: 'document.pdf',
        },
        settings: {
          colorMode: 'COLOR',
          paperSize: 'A4',
          orientation: 'LANDSCAPE',
          copies: 2,
        },
      }),
    );
    expect(f.gateway.emitPrintCommands).toHaveBeenCalledWith(
      'shop-1',
      'device-1',
      [{ attemptId: 'attempt-order-1' }],
    );
    expect(result).toMatchObject({
      requestId: REQUEST,
      deviceId: 'device-1',
      spooledCount: 1,
      attempts: [
        expect.objectContaining({
          attemptId: 'attempt-order-1',
          status: 'QUEUED',
        }),
      ],
    });
    expect(f.jobs.completeBatchRequest).toHaveBeenCalledWith(
      REQUEST,
      'shop-1',
      'COMPLETED',
      result,
    );
  });

  it('uses legacy portrait and one-copy defaults in preparation and settings', async () => {
    const f = setup();
    f.query.in.mockResolvedValue({
      data: [
        {
          ...f.orders[0],
          id: 'old',
          orientation: null,
          copies: null,
          assets: [{ file_url: 'old.pdf' }],
        },
      ],
    });
    await f.run(['old']);
    expect(f.printAssets.preparePinned).toHaveBeenCalledWith(
      'old.pdf',
      'shop-1',
      'old',
      'A4',
      'PORTRAIT',
    );
    const created = f.jobs.createAttempt.mock.calls[0] as unknown as [
      { settings: Record<string, unknown> },
    ];
    expect(created[0].settings).toMatchObject({
      orientation: 'PORTRAIT',
      copies: 1,
    });
  });

  it('records a known delivery failure when the agent disconnects before dispatch', async () => {
    const f = setup();
    f.gateway.emitPrintCommands.mockReturnValueOnce(false);
    await expect(f.run()).rejects.toThrow(ConflictException);
    expect(f.jobs.markUndelivered).toHaveBeenCalledWith(
      ['attempt-order-1'],
      'shop-1',
      'AGENT_DISCONNECTED',
      expect.any(String),
    );
    expect(f.gateway.broadcastAttempt).toHaveBeenCalledWith(
      'shop-1',
      expect.objectContaining({ status: 'FAILED_PRE_SUBMISSION' }),
    );
  });

  it('replays a recorded outcome for a repeated request instead of creating another batch', async () => {
    const f = setup();
    f.jobs.beginBatchRequest.mockResolvedValue({
      state: 'DONE',
      status: 'COMPLETED',
      response: { spooledCount: 1, requestId: REQUEST },
    });
    await expect(f.run()).resolves.toEqual({
      spooledCount: 1,
      requestId: REQUEST,
      replayed: true,
    });
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });

  it('replays a recorded failure and rejects a reused request with other contents', async () => {
    const f = setup();
    f.jobs.beginBatchRequest.mockResolvedValueOnce({
      state: 'DONE',
      status: 'FAILED',
      response: { statusCode: 409, body: { message: 'Agent offline' } },
    });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    f.jobs.beginBatchRequest.mockResolvedValueOnce({ state: 'CONFLICT' });
    await expect(f.run()).rejects.toThrow('different selection');
    f.jobs.beginBatchRequest.mockResolvedValueOnce({ state: 'IN_PROGRESS' });
    await expect(f.run()).rejects.toThrow('already being processed');
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
  });

  it('binds the request identifier to the reviewed selection', async () => {
    const f = setup();
    await f.run(['order-1']);
    // Same request ID, different reviewed printer: a different binding.
    await f.run(['order-1'], 'Removed').catch(() => undefined);
    const [first, second] = f.jobs.beginBatchRequest.mock.calls.map(
      (call: unknown[]) => call[2],
    );
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe('PrintSpoolerService manual production and recovery', () => {
  it('records manual attempts before returning pinned downloads, without the agent', async () => {
    const f = setup();
    f.jobs.findAttempts.mockImplementation((ids: string[]) =>
      Promise.resolve(
        ids.map((id) =>
          attempt(id.replace('attempt-', ''), {
            execution_mode: 'MANUAL',
            status: 'MANUAL_STARTED',
            device_id: null,
          }),
        ),
      ),
    );
    f.gateway.hasConnectedDaemon.mockReturnValue(false);
    const result = await f.service.startManualProduction({
      orderIds: ['order-1'],
      shopId: 'shop-1',
      actorId: 'shop-1',
      requestId: REQUEST,
    });
    expect(f.jobs.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'MANUAL', deviceId: null }),
    );
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
    expect(result.downloads).toEqual([
      {
        attemptId: 'attempt-order-1',
        orderId: 'order-1',
        url: 'https://signed/print-ready/order-1.pdf',
        fileName: 'Order_order-1_Thesis_draft.pdf',
      },
    ]);
    const recorded = f.jobs.completeBatchRequest.mock.calls[0] as unknown[];
    expect(recorded[3]).not.toHaveProperty('downloads');
  });

  it('retries with the same pinned file, revision and approved settings', async () => {
    const f = setup();
    const failed = attempt('order-1', { status: 'FAILED_PRE_SUBMISSION' });
    f.jobs.findAttempt.mockResolvedValue(failed);
    f.jobs.createAttempt.mockResolvedValueOnce({
      ok: true,
      attempt: attempt('order-1', {
        attempt_id: 'retry',
        attempt_kind: 'RETRY',
      }),
    });
    const result = await f.service.retryAttempt({
      attemptId: failed.attempt_id,
      shopId: 'shop-1',
      actorId: 'shop-1',
      mode: 'AGENT',
    });
    expect(f.printAssets.preparePinned).not.toHaveBeenCalled();
    expect(f.jobs.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'RETRY',
        previousAttemptId: failed.attempt_id,
        revisionId: 'document.pdf',
        printable: {
          path: failed.printable_path,
          sha256: failed.printable_sha256,
          size: 100,
        },
        settings: failed.print_settings,
        printerName: 'Desk',
      }),
    );
    expect(f.gateway.emitPrintCommands).toHaveBeenCalled();
    expect(result.attempt).toMatchObject({ attemptId: 'retry', kind: 'RETRY' });
  });

  it('refuses a retry once the approved revision changed', async () => {
    const f = setup();
    f.jobs.findAttempt.mockResolvedValue(
      attempt('order-1', {
        status: 'FAILED_PRE_SUBMISSION',
        revision_ref: 'older.pdf',
      }),
    );
    await expect(
      f.service.retryAttempt({
        attemptId: 'attempt-order-1',
        shopId: 'shop-1',
        actorId: 'shop-1',
        mode: 'MANUAL',
      }),
    ).rejects.toThrow('revision changed');
    expect(f.jobs.createAttempt).not.toHaveBeenCalled();
  });

  it('maps database refusals to operator-facing errors', async () => {
    const f = setup();
    f.jobs.findAttempt.mockResolvedValue(
      attempt('order-1', { status: 'OUTCOME_UNKNOWN' }),
    );
    f.jobs.createAttempt.mockResolvedValueOnce({
      ok: false,
      code: 'RECONCILIATION_REQUIRED',
    });
    await expect(
      f.service.retryAttempt({
        attemptId: 'attempt-order-1',
        shopId: 'shop-1',
        actorId: 'shop-1',
        mode: 'AGENT',
      }),
    ).rejects.toThrow('stopped or cleared');
    expect(f.gateway.emitPrintCommands).not.toHaveBeenCalled();
  });

  it('requires confirmation that the entire job is repeated for a reprint', async () => {
    const f = setup();
    await expect(
      f.service.reprintOrder({
        orderId: 'order-1',
        shopId: 'shop-1',
        actorId: 'shop-1',
        expectedAttemptId: 'attempt-order-1',
        mode: 'MANUAL',
        reason: 'Smudged',
        confirmFullJob: false,
      }),
    ).rejects.toThrow('entire approved job');
    f.jobs.findAttempt.mockResolvedValue(
      attempt('order-1', { status: 'SUBMITTED' }),
    );
    const result = await f.service.reprintOrder({
      orderId: 'order-1',
      shopId: 'shop-1',
      actorId: 'shop-1',
      expectedAttemptId: 'attempt-order-1',
      mode: 'MANUAL',
      reason: 'Smudged',
      confirmFullJob: true,
    });
    expect(f.jobs.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'REPRINT',
        mode: 'MANUAL',
        reason: 'Smudged',
        previousAttemptId: 'attempt-order-1',
      }),
    );
    expect(result.download).toEqual({
      url: 'https://signed/print-ready/order-1.pdf',
      fileName: 'Order_order-1_Thesis_draft.pdf',
    });
  });
});
