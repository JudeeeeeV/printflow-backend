import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrintSpoolerService } from './print-spooler.service';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseService } from '../supabase/supabase.service';

function setup() {
  const gateway = {
    hasConnectedDaemon: jest.fn().mockReturnValue(true),
    getAvailablePrinters: jest.fn().mockReturnValue(['Desk']),
    emitBatchExecute: jest.fn().mockReturnValue(true),
  };
  const jobs = {
    claimJob: jest.fn().mockResolvedValue(true),
    updateJobStatus: jest.fn().mockResolvedValue(undefined),
  };
  const query: {
    select: () => unknown;
    eq: () => unknown;
    single: jest.Mock;
    in: jest.Mock;
  } = {
    select: () => query,
    eq: () => query,
    single: jest.fn().mockResolvedValue({ data: { id: 'shop-1' } }),
    in: jest.fn().mockResolvedValue({
      data: [
        {
          id: 'order-1',
          state: 'IN_PRODUCTION',
          print_color_mode: 'COLOR',
          assets: [{ file_url: 'document.pdf' }],
        },
      ],
    }),
  };
  const supabase = {
    getAdminClient: () => ({ from: () => query }),
    ensurePrivateBucket: jest.fn().mockResolvedValue(undefined),
    createSignedStorageUrl: jest
      .fn()
      .mockResolvedValue('https://example.test/signed.pdf'),
  };
  const service = new PrintSpoolerService(
    gateway as unknown as EdgeDaemonGateway,
    jobs as unknown as PrintJobsRepository,
    supabase as unknown as SupabaseService,
  );
  return { service, gateway, jobs, supabase };
}

describe('PrintSpoolerService readiness', () => {
  it('returns an actionable conflict for an offline agent without claiming jobs', async () => {
    const { service, gateway, jobs, supabase } = setup();
    gateway.hasConnectedDaemon.mockReturnValue(false);
    await expect(
      service.executeBatch(['order-1'], 'shop-1', 'Desk'),
    ).rejects.toThrow(ConflictException);
    expect(jobs.claimJob).not.toHaveBeenCalled();
    expect(supabase.ensurePrivateBucket).not.toHaveBeenCalled();
  });

  it('rejects sending while no printers have been reported', async () => {
    const { service, gateway, jobs } = setup();
    gateway.getAvailablePrinters.mockReturnValue([]);
    await expect(service.executeBatch(['order-1'], 'shop-1')).rejects.toThrow(
      'has not reported any printers',
    );
    expect(jobs.claimJob).not.toHaveBeenCalled();
    expect(gateway.emitBatchExecute).not.toHaveBeenCalled();
  });

  it('rejects a printer removed since the dashboard last refreshed', async () => {
    const { service, jobs } = setup();
    await expect(
      service.executeBatch(['order-1'], 'shop-1', 'Removed'),
    ).rejects.toThrow(BadRequestException);
    expect(jobs.claimJob).not.toHaveBeenCalled();
  });

  it('dispatches a valid order to a reported printer', async () => {
    const { service, gateway } = setup();
    await expect(
      service.executeBatch(['order-1'], 'shop-1', 'Desk'),
    ).resolves.toMatchObject({ spooledCount: 1 });
    expect(gateway.emitBatchExecute).toHaveBeenCalledWith('shop-1', {
      printerName: 'Desk',
      orders: [
        {
          id: 'order-1',
          file_url: 'https://example.test/signed.pdf',
          print_color_mode: 'COLOR',
        },
      ],
    });
  });

  it('allows retry after the agent disconnects before dispatch', async () => {
    const { service, gateway, jobs } = setup();
    gateway.emitBatchExecute.mockReturnValueOnce(false);
    await expect(
      service.executeBatch(['order-1'], 'shop-1', 'Desk'),
    ).rejects.toThrow(ConflictException);
    expect(jobs.updateJobStatus).toHaveBeenCalledWith(
      'order-1',
      'shop-1',
      'FAILED',
    );
    await expect(
      service.executeBatch(['order-1'], 'shop-1', 'Desk'),
    ).resolves.toMatchObject({ spooledCount: 1 });
  });
});
