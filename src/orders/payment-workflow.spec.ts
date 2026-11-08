import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { applyOrderDecision, throwPaymentError } from './payment-workflow';
import { SupabaseService } from '../supabase/supabase.service';
import { OrderDecisionDto } from './dto/order-decision.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { UploadReceiptDto } from './dto/upload-receipt.dto';
import { createClient } from '@supabase/supabase-js';
import { OrderDecisionUnavailableException } from '../common/order-decision-unavailable.exception';

describe('payment decision RPC boundary', () => {
  it.each(['57014', '40P01', 'PGRST202', 'unsafe detail\n'])(
    'logs only a safe code for an unexpected database failure: %s',
    (code) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        expect(() =>
          throwPaymentError({ code, message: 'Private database detail' }),
        ).toThrow(InternalServerErrorException);
        expect(log).toHaveBeenCalledWith(
          `Order decision database request failed [code=${code === 'unsafe detail\n' ? 'UNKNOWN' : code}].`,
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain(
          'Private database detail',
        );
      } finally {
        log.mockRestore();
      }
    },
  );
  it.each([
    'function apply_order_decision',
    'schema public',
    'table orders',
    'sequence order_decisions_id_seq',
  ])(
    'distinguishes a database permission failure for %s from account authorization',
    (resource) => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        expect(() =>
          throwPaymentError({
            code: '42501',
            message: `permission denied for ${resource}`,
          }),
        ).toThrow(ServiceUnavailableException);
        expect(log).toHaveBeenCalledWith(
          'Payment database permission denied. Check the service-role client and payment migration grants.',
        );
      } finally {
        log.mockRestore();
      }
    },
  );
  const order = {
    id: 'order',
    state: 'OPEN_INQUIRY',
    payment_status: 'VERIFIED',
    acceptance_status: 'PENDING',
  };
  it('binds actor, order, action and receipt without inferring production from payment', async () => {
    const rpc = jest.fn().mockReturnValue({
      abortSignal: jest.fn().mockResolvedValue({ data: order, error: null }),
    });
    const service = {
      getAdminClient: () => ({ rpc }),
    } as unknown as SupabaseService;
    const result = await applyOrderDecision(
      service,
      'order',
      'clerk',
      'SHOP',
      'VERIFY',
      { receiptId: 'current', confirmed: true },
    );
    expect(rpc).toHaveBeenCalledWith('apply_order_decision', {
      p_order: 'order',
      p_actor: 'clerk',
      p_actor_type: 'SHOP',
      p_action: 'VERIFY',
      p_data: { receiptId: 'current', confirmed: true },
    });
    expect(result).toEqual(order);
    expect(result.acceptance_status).toBe('PENDING');
    expect(result.state).toBe('OPEN_INQUIRY');
  });
  it.each([
    ['55P03', ConflictException],
    ['40001', ConflictException],
    ['23505', ConflictException],
    ['42501', ForbiddenException],
    ['P0002', NotFoundException],
    ['23514', BadRequestException],
  ])(
    'maps database code %s to a safe application error',
    async (code, exception) => {
      const service = {
        getAdminClient: () => ({
          rpc: jest.fn().mockReturnValue({
            abortSignal: jest.fn().mockResolvedValue({
              error: { code, message: 'internal database detail' },
            }),
          }),
        }),
      } as unknown as SupabaseService;
      await expect(
        applyOrderDecision(service, 'order', 'actor', 'SHOP', 'ACCEPT'),
      ).rejects.toBeInstanceOf(exception);
      await expect(
        applyOrderDecision(service, 'order', 'actor', 'SHOP', 'ACCEPT'),
      ).rejects.not.toThrow('internal database detail');
    },
  );
  it('explains a database lock conflict without exposing database details', () => {
    expect(() =>
      throwPaymentError({
        code: '55P03',
        message: 'Private transaction detail',
      }),
    ).toThrow(
      'Another action is updating this order. Refresh its status and try again shortly.',
    );
  });
  describe('database connection failures', () => {
    let log: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers();
      log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      log.mockRestore();
      jest.useRealTimers();
    });

    function serviceWithFetch(fetch: typeof globalThis.fetch) {
      // The installed SDK runs against an injected fetch; no network or real
      // database is used. This covers its empty-code transport error responses.
      const client = createClient('https://database.example.test', 'test-key', {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch },
      });
      return { getAdminClient: () => client } as unknown as SupabaseService;
    }

    it('aborts a stalled decision after 15 seconds without retrying the write', async () => {
      const fetch = jest
        .fn<
          ReturnType<typeof globalThis.fetch>,
          Parameters<typeof globalThis.fetch>
        >()
        .mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                reject(new DOMException('Request aborted', 'AbortError')),
              );
            }),
        );
      const decision = applyOrderDecision(
        serviceWithFetch(fetch),
        'order',
        'shop',
        'SHOP',
        'ACCEPT',
      );
      const assertion = expect(decision).rejects.toBeInstanceOf(
        OrderDecisionUnavailableException,
      );
      await jest.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'Order decision connection failed [code=REQUEST_TIMEOUT, httpStatus=0, durationMs=15000].',
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('identifies a transport cause without logging private error details', async () => {
      const fetch = jest
        .fn<
          ReturnType<typeof globalThis.fetch>,
          Parameters<typeof globalThis.fetch>
        >()
        .mockRejectedValue(
          new TypeError('Private upstream address', {
            cause: Object.assign(new Error('Private connection detail'), {
              code: 'ECONNRESET',
            }),
          }),
        );
      await expect(
        applyOrderDecision(
          serviceWithFetch(fetch),
          'order',
          'shop',
          'SHOP',
          'ACCEPT',
        ),
      ).rejects.toBeInstanceOf(OrderDecisionUnavailableException);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'Order decision connection failed [code=ECONNRESET, httpStatus=0, durationMs=0].',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('Private');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('handles an upstream gateway failure without exposing its response', async () => {
      const fetch = jest
        .fn<
          ReturnType<typeof globalThis.fetch>,
          Parameters<typeof globalThis.fetch>
        >()
        .mockResolvedValue(
          new Response('Private gateway detail', { status: 502 }),
        );
      await expect(
        applyOrderDecision(
          serviceWithFetch(fetch),
          'order',
          'shop',
          'SHOP',
          'ACCEPT',
        ),
      ).rejects.toBeInstanceOf(OrderDecisionUnavailableException);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        'Order decision connection failed [code=UPSTREAM_UNAVAILABLE, httpStatus=502, durationMs=0].',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('Private');
      expect(jest.getTimerCount()).toBe(0);
    });

    it('returns an accepted cash order and clears the deadline after a successful response', async () => {
      const accepted = {
        ...order,
        state: 'IN_PRODUCTION',
        payment_method: 'CASH_ON_PICKUP',
        payment_status: 'DUE_AT_PICKUP',
        acceptance_status: 'ACCEPTED',
      };
      const fetch = jest
        .fn<
          ReturnType<typeof globalThis.fetch>,
          Parameters<typeof globalThis.fetch>
        >()
        .mockResolvedValue(Response.json(accepted));
      await expect(
        applyOrderDecision(
          serviceWithFetch(fetch),
          'order',
          'shop',
          'SHOP',
          'ACCEPT',
        ),
      ).resolves.toEqual(accepted);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
  it('does not accept client actor identities, lifecycle shortcuts, or missing receipt identity', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform({}, { type: 'body', metatype: UploadReceiptDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { referenceNumber: '   ' },
        { type: 'body', metatype: UploadReceiptDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { action: 'ACCEPT', actorId: 'another-user' },
        { type: 'body', metatype: OrderDecisionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { action: 'COMPLETED' },
        { type: 'body', metatype: OrderDecisionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { action: 'APPROVE', confirmed: true },
        { type: 'body', metatype: VerifyPaymentDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
