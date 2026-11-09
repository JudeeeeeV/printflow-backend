import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ShopQueueService,
  queueSummary,
  type QueueRow,
} from './shop-queue.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ShopQueueQueryDto } from './dto/shop-queue.dto';
import { BatchPreviewDto } from '../edge/dto/batch-review.dto';

function fixture() {
  const single = jest
    .fn()
    .mockResolvedValue({ data: { id: 'shop' }, error: null });
  const from = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: single,
  });
  const rpc = jest.fn().mockResolvedValue({ data: [], error: null });
  const sign = jest.fn();
  const supabase = {
    getAdminClient: () => ({ from, rpc }),
    createSignedStorageUrl: sign,
  };
  return {
    service: new ShopQueueService(supabase as unknown as SupabaseService),
    single,
    from,
    rpc,
    sign,
  };
}
describe('Shop queue reads', () => {
  it('enforces verified-shop access and keeps database failures distinct from missing shops', async () => {
    const f = fixture();
    f.single.mockResolvedValue({ data: null, error: null });
    await expect(f.service.items('other', ['id'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.rpc).not.toHaveBeenCalled();
    f.single.mockResolvedValue({ data: null, error: { code: '503' } });
    await expect(f.service.items('shop', ['id'])).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
  it('keeps queue summaries free of source paths and pinned file identities', () => {
    const summary = queueSummary({
      id: 'id',
      source_path: 'private/source.pdf',
      raw_attempt: {
        revision_ref: 'private/source.pdf',
        printable_path: 'private/pinned.pdf',
      },
    } as QueueRow);
    expect(JSON.stringify(summary)).not.toContain('private/');
    expect(summary).not.toHaveProperty('source_path');
    expect(summary).not.toHaveProperty('raw_attempt');
  });
  it('does not fetch or sign another shop’s order', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: null, error: null });
    await expect(f.service.details('shop', 'not-owned')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.rpc).toHaveBeenCalledWith('shop_queue_detail', {
      p_shop: 'shop',
      p_order: 'not-owned',
    });
    expect(f.from).toHaveBeenCalledTimes(1);
    expect(f.sign).not.toHaveBeenCalled();
  });
  it('signs files and the current receipt from one authorized detail snapshot', async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({
      data: {
        id: 'order',
        state: 'OPEN_INQUIRY',
        current_receipt_id: 'current',
        source_path: 'private/source.pdf',
        raw_attempt: null,
        assets: [
          { original_filename: 'Report.pdf', file_url: 'private/source.pdf' },
        ],
        payment_receipts: [
          { id: 'current', receipt_url: 'private/current.png' },
        ],
      },
      error: null,
    });
    f.sign.mockImplementation((bucket: string, path: string) =>
      Promise.resolve(`${bucket}:signed:${path}`),
    );
    const result = await f.service.details('shop', 'order');
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(f.from).toHaveBeenCalledTimes(1); // Shop authorization only; no second order snapshot.
    expect(result.current_receipt_id).toBe('current');
    expect(result.assets[0].file_url).toBe('assets:signed:private/source.pdf');
    expect(result.payment_receipts[0].receipt_url).toBe(
      'receipts:signed:private/current.png',
    );
    expect(result).not.toHaveProperty('source_path');
    expect(result).not.toHaveProperty('raw_attempt');
  });
  it('rejects reversed date ranges before running the query', async () => {
    const f = fixture();
    await expect(
      f.service.query(
        'shop',
        plainToInstance(ShopQueueQueryDto, {
          dateFrom: '2026-10-11',
          dateTo: '2026-10-10',
        }),
      ),
    ).rejects.toThrow('start date');
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
describe('Queue input validation', () => {
  it('validates pagination, selectable flags, bounded IDs and full calendar dates', async () => {
    const input = plainToInstance(ShopQueueQueryDto, {
      section: 'ready',
      page: '2',
      pageSize: '3',
      selectableOnly: 'true',
      onlyIds: '00000000-0000-4000-8000-000000000001',
    });
    expect(await validate(input)).toHaveLength(0);
    expect(input.page).toBe(2);
    expect(input.selectableOnly).toBe(true);
    expect(input.onlyIds).toHaveLength(1);
    for (const value of ['2026', '2026-11', '2026-W45']) {
      for (const field of ['dateFrom', 'dateTo']) {
        expect(
          (
            await validate(
              plainToInstance(ShopQueueQueryDto, { [field]: value }),
            )
          ).length,
        ).toBeGreaterThan(0);
      }
    }
  });
  it.each([
    { pageSize: '500' },
    { page: '-1' },
    { dateFrom: '2026-02-30' },
    { selectableOnly: 'anything' },
    { section: 'another-shop' },
    { onlyIds: 'invalid' },
  ])('rejects invalid query %j', async (value) => {
    expect(
      (await validate(plainToInstance(ShopQueueQueryDto, value))).length,
    ).toBeGreaterThan(0);
  });
  it('reports malformed and duplicate preview selections as validation failures', async () => {
    expect(
      (
        await validate(
          plainToInstance(BatchPreviewDto, { mode: 'MANUAL', orders: [null] }),
        )
      ).length,
    ).toBeGreaterThan(0);
    const item = {
      orderId: '00000000-0000-4000-8000-000000000001',
      fingerprint: 'a'.repeat(32),
    };
    expect(
      (
        await validate(
          plainToInstance(BatchPreviewDto, {
            mode: 'MANUAL',
            orders: [item, item],
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
