import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrintSpoolerService } from './print-spooler.service';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintAssetService } from './print-asset.service';

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
          paper_size: 'A4',
          orientation: 'LANDSCAPE',
          copies: 2,
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
  const printAssets = {
    prepare: jest.fn().mockResolvedValue('https://example.test/signed.pdf'),
  };
  const service = new PrintSpoolerService(
    gateway as unknown as EdgeDaemonGateway,
    jobs as unknown as PrintJobsRepository,
    supabase as unknown as SupabaseService,
    printAssets as unknown as PrintAssetService,
  );
  return { service, gateway, jobs, supabase, printAssets, query };
}

describe('PrintSpoolerService readiness', () => {
  it('does not claim any jobs if preparing a later file fails', async () => {
    const { service, jobs, printAssets, query } = setup();
    query.in.mockResolvedValue({
      data: ['one', 'two'].map((id) => ({
        id,
        state: 'IN_PRODUCTION',
        paper_size: 'A4',
        print_color_mode: 'COLOR',
        assets: [{ file_url: `${id}.png` }],
      })),
    });
    printAssets.prepare
      .mockResolvedValueOnce('https://example.test/one.pdf')
      .mockRejectedValueOnce(new BadRequestException('Invalid file'));
    await expect(
      service.executeBatch(['one', 'two'], 'shop-1', 'Desk'),
    ).rejects.toThrow('Invalid file');
    expect(jobs.claimJob).not.toHaveBeenCalled();
  });

  it('does not report a successful dispatch when all jobs are already claimed', async () => {
    const { service, jobs, gateway } = setup();
    jobs.claimJob.mockResolvedValue(false);
    await expect(
      service.executeBatch(['order-1'], 'shop-1', 'Desk'),
    ).rejects.toThrow(ConflictException);
    expect(gateway.emitBatchExecute).not.toHaveBeenCalled();
  });

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
          paper_size: 'A4',
          orientation: 'LANDSCAPE',
          copies: 2,
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
