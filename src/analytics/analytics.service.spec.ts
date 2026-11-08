import { AnalyticsService } from './analytics.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('payment-based analytics', () => {
  it('counts verified GCash and collected cash while retaining unpaid pickup balances', async () => {
    const orders = [
      {
        id: 'verified',
        state: 'OPEN_INQUIRY',
        payment_method: 'GCASH',
        payment_status: 'VERIFIED',
        total: 20,
      },
      {
        id: 'cash-due',
        state: 'READY_FOR_PICKUP',
        payment_method: 'CASH_ON_PICKUP',
        payment_status: 'DUE_AT_PICKUP',
        total: 30,
      },
      {
        id: 'cash-paid',
        state: 'COMPLETED',
        payment_method: 'CASH_ON_PICKUP',
        payment_status: 'COLLECTED',
        total: 40,
      },
      {
        id: 'refund-due',
        state: 'CANCELLED',
        payment_method: 'GCASH',
        payment_status: 'REFUND_DUE',
        total: 50,
      },
      {
        id: 'refunded',
        state: 'REJECTED',
        payment_method: 'GCASH',
        payment_status: 'REFUNDED',
        total: 60,
      },
      {
        id: 'uncertain',
        state: 'IN_PRODUCTION',
        payment_method: 'GCASH',
        payment_status: 'REVIEW_REQUIRED',
        total: 70,
      },
    ].map((order) => ({
      ...order,
      page_count: 2,
      print_color_mode: 'BLACK_AND_WHITE',
      paper_size: 'A4',
      client_id: 'student',
      assets: [],
      created_at: '2026-11-06T01:00:00Z',
    }));
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: orders, error: null }),
      single: jest
        .fn()
        .mockResolvedValue({ data: { id: 'shop' }, error: null }),
    };
    const service = new AnalyticsService({
      getAdminClient: () => ({ from: () => query }),
    } as unknown as SupabaseService);
    const result = await service.getShopAnalytics('shop');
    expect(result.totalRevenue).toBe('60.00');
    expect(result.pendingRevenue).toBe('100.00');
    expect(result.printVolumeOverTime[0].revenue).toBe(60);
    expect(
      result.recentOrders.find((order) => order.id === 'cash-due')
        ?.paymentStatus,
    ).toBe('DUE_AT_PICKUP');
  });
});
