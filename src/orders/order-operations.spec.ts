import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type ExecutionContext,
} from '@nestjs/common';
import { OrderDecisionUnavailableException } from '../common/order-decision-unavailable.exception';
import { SupabaseService } from '../supabase/supabase.service';
import { IdempotencyKeyGuard } from './idempotency-key.guard';
import {
  OperationInProgressException,
  operationFingerprint,
  OrderOperations,
  type OperationClaim,
} from './order-operations';

const request = {
  userId: 'student',
  key: 'key',
  action: 'CREATE_ORDER' as const,
  targetId: 'shop',
  fingerprint: 'fingerprint',
  contentHash: 'hash',
};

function fixture(claim: unknown, row: unknown = null) {
  const updates: Array<Record<string, unknown>> = [];
  const table: Record<string, unknown> = {
    update: jest.fn((values: Record<string, unknown>) => {
      updates.push(values);
      return table;
    }),
    match: jest.fn(() => table),
    select: jest.fn(() => table),
    eq: jest.fn(() => table),
    maybeSingle: jest.fn(() =>
      Promise.resolve({
        data: updates.length
          ? { staged_bucket: 'assets', staged_path: 'staged.pdf' }
          : row,
        error: null,
      }),
    ),
    then: (resolve: (value: unknown) => void) =>
      resolve({ data: null, error: null }),
  };
  const remove = jest.fn().mockResolvedValue({ error: null });
  const commitResponse = {
    abortSignal: jest.fn().mockResolvedValue({
      data: { result: { orderId: 'order' }, replacedPaths: [] },
      error: null,
      status: 200,
    }),
  };
  const rpc = jest.fn((name: string) =>
    name === 'claim_order_operation'
      ? Promise.resolve({ data: claim, error: null })
      : commitResponse,
  );
  const client = {
    rpc,
    from: jest.fn(() => table),
    storage: { from: jest.fn(() => ({ remove })) },
  };
  const operations = new OrderOperations({
    getAdminClient: () => client,
  } as unknown as SupabaseService);
  return { operations, rpc, updates, remove, commitResponse };
}

const claimed = { outcome: 'claimed', generation: 1, plannedOrderId: 'order' };

describe('OrderOperations.run', () => {
  it('commits a claimed operation', async () => {
    const f = fixture(claimed);
    await expect(
      f.operations.run(request, async (claim) => {
        expect(claim.plannedOrderId).toBe('order');
        return (await claim.commit({ message: 'x' })).result;
      }),
    ).resolves.toEqual({ orderId: 'order' });
  });

  it('replays a committed result without running any business rule', async () => {
    const f = fixture({ outcome: 'succeeded', result: { orderId: 'first' } });
    const work = jest.fn();
    await expect(f.operations.run(request, work)).resolves.toEqual({
      orderId: 'first',
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('reports an in-flight operation as accepted', async () => {
    const f = fixture({ outcome: 'processing', retryAfterSeconds: 7 });
    const error = await f.operations
      .run(request, jest.fn())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationInProgressException);
    expect((error as OperationInProgressException).getStatus()).toBe(202);
    expect((error as OperationInProgressException).getResponse()).toEqual({
      status: 'processing',
      operationKey: 'key',
      retryAfterSeconds: 7,
    });
  });

  it('rejects a reused key with different inputs', async () => {
    const f = fixture({ outcome: 'conflict' });
    await expect(f.operations.run(request, jest.fn())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('replays a final failure with its original response', async () => {
    const f = fixture({
      outcome: 'failed',
      errorStatus: 400,
      errorBody: { message: 'Closed' },
    });
    const error = await f.operations
      .run(request, jest.fn())
      .catch((e: { getStatus(): number; getResponse(): unknown }) => e);
    expect((error as { getStatus(): number }).getStatus()).toBe(400);
    expect((error as { getResponse(): unknown }).getResponse()).toEqual({
      message: 'Closed',
    });
  });

  it('records a confirmed rejection and removes its staged file', async () => {
    const f = fixture(claimed);
    await expect(
      f.operations.run(request, () =>
        Promise.reject(new BadRequestException('Closed')),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.updates[0]).toMatchObject({
      status: 'FAILED',
      retryable: false,
      error_status: 400,
    });
    expect(f.remove).toHaveBeenCalledWith(['staged.pdf']);
  });

  it('keeps server details out of retryable failures', async () => {
    const f = fixture(claimed);
    await expect(
      f.operations.run(request, () =>
        Promise.reject(new ServiceUnavailableException('private detail')),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.updates[0]).toMatchObject({
      retryable: true,
      error_status: 503,
      error_body: null,
    });
  });

  const failCommit = (f: ReturnType<typeof fixture>) => (c: OperationClaim) =>
    c.commit({ message: 'x' }).then(() => {
      f.commitResponse.abortSignal.mockClear();
      return 'committed';
    });

  it('returns the result when a lost commit actually landed', async () => {
    const f = fixture(claimed, {
      status: 'SUCCEEDED',
      result: { orderId: 'landed' },
    });
    f.commitResponse.abortSignal.mockRejectedValue(new Error('socket hang up'));
    await expect(f.operations.run(request, failCommit(f))).resolves.toEqual({
      orderId: 'landed',
    });
    expect(f.updates).toHaveLength(0);
  });

  it('never marks an uncertain commit as failed', async () => {
    const f = fixture(claimed, { status: 'PROCESSING' });
    f.commitResponse.abortSignal.mockRejectedValue(new Error('socket hang up'));
    await expect(
      f.operations.run(request, failCommit(f)),
    ).rejects.toBeInstanceOf(OrderDecisionUnavailableException);
    expect(f.updates).toHaveLength(0);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('treats a lost claim as uncertain', async () => {
    const f = fixture(claimed, { status: 'PROCESSING' });
    f.commitResponse.abortSignal.mockResolvedValue({
      data: null,
      error: { code: 'PF001', message: 'stale' },
      status: 400,
    });
    await expect(
      f.operations.run(request, failCommit(f)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.updates).toHaveLength(0);
  });

  it('reports a stale draft as a conflict', async () => {
    const f = fixture(claimed);
    f.commitResponse.abortSignal.mockResolvedValue({
      data: null,
      error: { code: 'PF003', message: 'stale' },
      status: 400,
    });
    await expect(
      f.operations.run(request, failCommit(f)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.updates[0]).toMatchObject({ status: 'FAILED', retryable: false });
  });
});

describe('OrderOperations.status', () => {
  const later = new Date(Date.now() + 60_000).toISOString();
  const earlier = new Date(Date.now() - 60_000).toISOString();

  it.each([
    [null, { status: 'unknown', retryAllowed: true }],
    [
      { status: 'SUCCEEDED', result: { orderId: 'o' } },
      { status: 'succeeded', retryAllowed: false, result: { orderId: 'o' } },
    ],
    [
      { status: 'PROCESSING', lease_expires_at: earlier },
      { status: 'processing', retryAllowed: true },
    ],
    [
      {
        status: 'FAILED',
        retryable: true,
        error_status: 503,
        error_body: null,
      },
      {
        status: 'failed',
        retryAllowed: true,
        error: { status: 503, data: null },
      },
    ],
  ])('maps %j', async (row, expected) => {
    await expect(
      fixture(null, row).operations.status('s', 'k'),
    ).resolves.toEqual(expected);
  });

  it('does not offer retry while a lease is live', async () => {
    await expect(
      fixture(null, {
        status: 'PROCESSING',
        lease_expires_at: later,
      }).operations.status('s', 'k'),
    ).resolves.toMatchObject({ status: 'processing', retryAllowed: false });
  });
});

describe('operationFingerprint', () => {
  it('ignores key order and undefined fields', () => {
    expect(operationFingerprint({ a: 1, b: { c: 2, d: undefined } })).toBe(
      operationFingerprint({ b: { c: 2 }, a: 1 }),
    );
  });

  it('changes with the inputs', () => {
    expect(operationFingerprint({ copies: 1 })).not.toBe(
      operationFingerprint({ copies: 2 }),
    );
  });
});

describe('IdempotencyKeyGuard', () => {
  const guard = new IdempotencyKeyGuard();
  const context = (headers: Record<string, string>) => {
    const req: { headers: typeof headers; operationKey?: string } = { headers };
    return {
      req,
      ctx: {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext,
    };
  };
  const uuid = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';

  afterEach(() => delete process.env.REQUIRE_IDEMPOTENCY_KEY);

  it('normalizes a valid key', () => {
    const { req, ctx } = context({ 'idempotency-key': uuid });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.operationKey).toBe(uuid.toLowerCase());
  });

  it('rejects a malformed key', () => {
    expect(() =>
      guard.canActivate(context({ 'idempotency-key': 'nope' }).ctx),
    ).toThrow(BadRequestException);
  });

  it('serves older clients until the key is enforced', () => {
    const { req, ctx } = context({});
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.operationKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('asks for a refresh once enforced', () => {
    process.env.REQUIRE_IDEMPOTENCY_KEY = 'true';
    expect(() => guard.canActivate(context({}).ctx)).toThrow(
      expect.objectContaining({ status: 428 }) as Error,
    );
  });
});
