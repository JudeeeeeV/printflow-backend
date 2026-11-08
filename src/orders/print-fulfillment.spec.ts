import { SupabaseService } from '../supabase/supabase.service';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';
import {
  fulfillmentStage,
  isStale,
  STALE_PROGRESS_MS,
  type PrintAttemptRow,
} from './print-fulfillment';

const row = (overrides: Partial<PrintAttemptRow> = {}) =>
  ({
    status: 'QUEUED',
    resolved_at: null,
    updated_at: new Date(0).toISOString(),
    agent_seen_at: null,
    ...overrides,
  }) as PrintAttemptRow;

describe('student fulfillment stages', () => {
  it.each([
    ['IN_PRODUCTION', null, 'PREPARING'],
    ['IN_PRODUCTION', row({ status: 'QUEUED' }), 'PREPARING'],
    ['IN_PRODUCTION', row({ status: 'DOWNLOADING' }), 'PRINTING'],
    ['IN_PRODUCTION', row({ status: 'FAILED_PRE_SUBMISSION' }), 'PRINTING'],
    ['IN_PRODUCTION', row({ status: 'OUTCOME_UNKNOWN' }), 'PRINTING'],
    ['IN_PRODUCTION', row({ status: 'SUBMITTED' }), 'CHECKING_OUTPUT'],
    ['IN_PRODUCTION', row({ status: 'MANUAL_STARTED' }), 'CHECKING_OUTPUT'],
    ['PRINTED', null, 'CHECKING_OUTPUT'],
    ['READY_FOR_PICKUP', row({ status: 'SUBMITTED' }), 'READY_FOR_PICKUP'],
    ['COMPLETED', null, 'COMPLETED'],
    ['AWAITING_PAYMENT', null, null],
  ] as const)('%s with %j is %s', (state, attempt, stage) => {
    expect(fulfillmentStage(state, attempt)).toBe(stage);
  });
});

describe('stale progress', () => {
  it('warns after ten minutes without progress or agent heartbeat', () => {
    const now = STALE_PROGRESS_MS + 1;
    expect(isStale(row(), now)).toBe(true);
    // A job waiting behind other work is still reported by the heartbeat.
    expect(
      isStale(row({ agent_seen_at: new Date(now - 1000).toISOString() }), now),
    ).toBe(false);
    expect(isStale(row({ status: 'SUBMITTED' }), now)).toBe(false);
    expect(isStale(row({ resolved_at: new Date(0).toISOString() }), now)).toBe(
      false,
    );
  });
});

describe('OrdersService operator fulfillment decisions', () => {
  function fixture(result: unknown, error: unknown = null) {
    const rpc = jest.fn().mockResolvedValue({ data: result, error });
    const shopQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: 'shop' } }),
    };
    const service = new OrdersService(
      {
        getAdminClient: () => ({ rpc, from: () => shopQuery }),
      } as unknown as SupabaseService,
      {} as PrintableDocumentService,
    );
    return { service, rpc };
  }

  it('requires explicit confirmation before recording anything', async () => {
    const f = fixture({ ok: true });
    await expect(
      f.service.updateOrderState('shop', 'order', 'READY_FOR_PICKUP', {}),
    ).rejects.toThrow('Explicit operator confirmation');
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('sends only the known output checks with the expected attempt', async () => {
    const f = fixture({ ok: true, result: 'CONFIRMED' });
    await f.service.updateOrderState('shop', 'order', 'READY_FOR_PICKUP', {
      confirmed: true,
      expectedAttemptId: 'attempt',
      checks: { document: true, copies: 'yes', injected: true },
      reconciliationReason: '  ',
    });
    expect(f.rpc).toHaveBeenCalledWith('print_confirm_output', {
      p_order_id: 'order',
      p_shop_id: 'shop',
      p_expected_attempt_id: 'attempt',
      p_actor_id: 'shop',
      p_reason: null,
      p_checks: {
        document: true,
        revision: false,
        paper: false,
        color: false,
        orientation: false,
        pages: false,
        copies: false,
      },
    });
  });

  it('records handover through the payment-checked function and reports duplicates', async () => {
    const f = fixture({ ok: true, result: 'DUPLICATE' });
    await expect(
      f.service.updateOrderState('shop', 'order', 'COMPLETED', {
        confirmed: true,
        expectedAttemptId: 'attempt',
      }),
    ).resolves.toMatchObject({ state: 'COMPLETED', duplicate: true });
    expect(f.rpc).toHaveBeenCalledWith('print_record_handover', {
      p_order_id: 'order',
      p_shop_id: 'shop',
      p_expected_attempt_id: 'attempt',
      p_actor_id: 'shop',
    });
  });

  it.each([
    ['PAYMENT_NOT_SETTLED', 'Payment must be recorded'],
    ['OUTPUT_NOT_CONFIRMED', 'Confirm the printed output'],
    ['RECONCILIATION_REASON_REQUIRED', 'reconciliation reason'],
    ['ATTEMPT_NOT_CURRENT', 'no longer current'],
  ])('maps %s to an actionable error', async (code, message) => {
    const f = fixture({ ok: false, code });
    await expect(
      f.service.updateOrderState('shop', 'order', 'COMPLETED', {
        confirmed: true,
      }),
    ).rejects.toThrow(message);
  });
});
