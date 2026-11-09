import { ConflictException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';

function fixture(
  decision: { data: unknown; error: unknown; status: number },
  current: Record<string, unknown> | null,
) {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: current, error: null }),
  };
  const service = new OrdersService(
    {
      getAdminClient: () => ({
        from: () => query,
        rpc: () => ({ abortSignal: () => Promise.resolve(decision) }),
      }),
    } as unknown as SupabaseService,
    {} as PrintableDocumentService,
  );
  return { service, query };
}

const changed = {
  data: null,
  error: { code: '40001', message: 'cannot be disputed' },
  status: 409,
};

describe('OrdersService.disputePayment retries', () => {
  it('returns success when an earlier attempt already recorded the dispute', async () => {
    const order = {
      id: 'o',
      state: 'OPEN_INQUIRY',
      payment_status: 'DISPUTED',
    };
    const f = fixture(changed, order);
    await expect(f.service.disputePayment('s', 'o', 'Paid')).resolves.toEqual({
      message: 'Payment dispute escalated.',
      state: 'OPEN_INQUIRY',
      order,
    });
    expect(f.query.eq).toHaveBeenCalledWith('client_id', 's');
  });

  it('keeps the conflict when the order is in any other state', async () => {
    const f = fixture(changed, { id: 'o', payment_status: 'VERIFIED' });
    await expect(
      f.service.disputePayment('s', 'o', 'Paid'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps the conflict when the order cannot be read', async () => {
    const f = fixture(changed, null);
    await expect(
      f.service.disputePayment('s', 'o', 'Paid'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not look up other failures', async () => {
    const f = fixture(
      { data: null, error: { code: 'P0002', message: 'none' }, status: 404 },
      null,
    );
    await expect(
      f.service.disputePayment('s', 'o', 'Paid'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.query.maybeSingle).not.toHaveBeenCalled();
  });
});
