import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';

function contextFor(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

describe('AdminAuthGuard', () => {
  const activeAdmin = {
    data: { id: 'admin-id', email: 'admin@example.com', is_2fa_enabled: true },
    error: null,
  };

  function createGuard(payload: any, adminResult = activeAdmin) {
    const sessionChain: any = {
      select: jest.fn(() => sessionChain),
      eq: jest.fn(() => sessionChain),
      is: jest.fn(() => sessionChain),
      gt: jest.fn(() => sessionChain),
      maybeSingle: jest.fn(async () => ({
        data: { id: 'session-id' },
        error: null,
      })),
    };
    const adminChain: any = {
      select: jest.fn(() => adminChain),
      eq: jest.fn(() => adminChain),
      single: jest.fn(async () => adminResult),
    };
    const jwtService = { verifyAsync: jest.fn(async () => payload) };
    const reflector = { getAllAndOverride: jest.fn(() => undefined) };
    const supabaseService = {
      getAdminClient: () => ({
        from: (table: string) =>
          table === 'admin_sessions' ? sessionChain : adminChain,
      }),
    };
    return {
      guard: new AdminAuthGuard(
        jwtService as any,
        reflector as any,
        supabaseService as any,
      ),
      reflector,
    };
  }

  it('accepts only a full 2FA token for ordinary admin routes', async () => {
    const request = { headers: { authorization: 'Bearer token' } };
    const { guard } = createGuard({
      sub: 'admin-id',
      email: 'admin@example.com',
      role: 'ADMIN',
      tokenType: 'admin-access',
      jti: 'session-token-id',
    });
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request).toHaveProperty('user.tokenType', 'admin-access');
  });

  it('rejects temporary tokens on full admin routes', async () => {
    const { guard } = createGuard({
      sub: 'admin-id',
      email: 'admin@example.com',
      tokenType: 'admin-temp',
    });
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer token' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a signed token whose admin record is missing', async () => {
    const { guard } = createGuard(
      {
        sub: 'admin-id',
        email: 'admin@example.com',
        role: 'ADMIN',
        tokenType: 'admin-access',
        jti: 'session-token-id',
      },
      { data: null, error: { message: 'not found' } } as any,
    );
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer token' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
