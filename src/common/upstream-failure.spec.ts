import {
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth.service';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { OrdersService } from '../orders/orders.service';
import { PrintableDocumentService } from '../orders/printable-document.service';
import { SupabaseService } from '../supabase/supabase.service';
import { isTemporaryAuthFailure, throwIfReadFailed } from './upstream-failure';

const outage = { code: '', message: 'TypeError: fetch failed' };
const noRow = { code: 'PGRST116', message: 'no rows' };

function profileClient(result: { data: unknown; error: unknown }) {
  return {
    from: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue(result),
    }),
  };
}

describe('throwIfReadFailed', () => {
  it.each([noRow, { code: '22P02', message: 'bad uuid' }, null, undefined])(
    'leaves a missing row to the caller: %j',
    (error) => expect(() => throwIfReadFailed(error)).not.toThrow(),
  );

  it('reports a failed read as unavailable', () => {
    expect(() => throwIfReadFailed(outage)).toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('isTemporaryAuthFailure', () => {
  it.each([
    [new AuthRetryableFetchError('Failed to fetch', 0), true],
    [
      new AuthApiError('Too many requests', 429, 'over_request_rate_limit'),
      true,
    ],
    [new AuthApiError('Database error', 500, undefined), true],
    [new AuthApiError('Invalid token', 400, 'refresh_token_not_found'), false],
    [new AuthApiError('Bad JWT', 403, 'bad_jwt'), false],
    [null, false],
  ])('classifies %s', (error, expected) => {
    expect(isTemporaryAuthFailure(error)).toBe(expected);
  });
});

describe('AuthService.refresh', () => {
  function service(
    refreshSession: jest.Mock,
    profile = profileClient({ data: { role: 'STUDENT' }, error: null }),
  ) {
    return new AuthService({
      createSessionClient: () => ({ auth: { refreshSession } }),
      getAdminClient: () => profile,
    } as unknown as SupabaseService);
  }
  const session = {
    data: {
      user: { id: 'student', email: 'student@example.com' },
      session: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
    },
    error: null,
  };
  const failure = (error: unknown) => ({
    data: { user: null, session: null },
    error,
  });

  it('keeps the session when Supabase cannot answer', async () => {
    await expect(
      service(
        jest
          .fn()
          .mockResolvedValue(
            failure(new AuthRetryableFetchError('Failed to fetch', 0)),
          ),
      ).refresh('token'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('keeps the session when the refresh call throws', async () => {
    await expect(
      service(jest.fn().mockRejectedValue(new Error('socket hang up'))).refresh(
        'token',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a token Supabase refused', async () => {
    await expect(
      service(
        jest
          .fn()
          .mockResolvedValue(
            failure(
              new AuthApiError('Invalid', 400, 'refresh_token_not_found'),
            ),
          ),
      ).refresh('token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not treat a failed profile read as a missing account', async () => {
    await expect(
      service(
        jest.fn().mockResolvedValue(session),
        profileClient({ data: null, error: outage }),
      ).refresh('token'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a confirmed missing profile', async () => {
    await expect(
      service(
        jest.fn().mockResolvedValue(session),
        profileClient({ data: null, error: noRow }),
      ).refresh('token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SupabaseAuthGuard', () => {
  function activate(
    authResult: { data: { user: unknown }; error: unknown },
    profile = profileClient({ data: { role: 'STUDENT' }, error: null }),
  ) {
    const client = {
      ...profile,
      auth: { getUser: jest.fn().mockResolvedValue(authResult) },
    };
    const guard = new SupabaseAuthGuard({
      getAdminClient: () => client,
    } as unknown as SupabaseService);
    return guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer token' },
          query: {},
        }),
      }),
    } as unknown as ExecutionContext);
  }

  it('reports an Auth outage instead of an invalid token', async () => {
    await expect(
      activate({
        data: { user: null },
        error: new AuthRetryableFetchError('Failed to fetch', 0),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('still rejects an invalid token', async () => {
    await expect(
      activate({
        data: { user: null },
        error: new AuthApiError('Bad JWT', 403, 'bad_jwt'),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reports a failed profile read as an outage', async () => {
    await expect(
      activate(
        { data: { user: { id: 'student' } }, error: null },
        profileClient({ data: null, error: outage }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('OrdersService.getOrder', () => {
  function service(error: unknown) {
    return new OrdersService(
      {
        getAdminClient: () => profileClient({ data: null, error }),
      } as unknown as SupabaseService,
      {} as PrintableDocumentService,
    );
  }

  it('returns not found only for a confirmed missing order', async () => {
    await expect(service(noRow).getOrder('s', 'o')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reports a database failure as unavailable', async () => {
    await expect(service(outage).getOrder('s', 'o')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
