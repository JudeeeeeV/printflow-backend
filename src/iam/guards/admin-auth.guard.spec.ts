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
          table === 'admins' ? adminChain : sessionChain,
      }),
    };
    return {
      guard: new AdminAuthGuard(
        jwtService as any,
        reflector as any,
        supabaseService as any,
      ),
      reflector,
      sessionChain,
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

  it('checks a temporary token against an unconsumed, unexpired database challenge', async () => {
    const { guard, reflector, sessionChain } = createGuard({
      sub: 'admin-id',
      email: 'admin@example.com',
      tokenType: 'admin-temp',
      jti: 'challenge-id',
    });
    reflector.getAllAndOverride.mockReturnValue('admin-temp' as any);
    const context = contextFor({ headers: { authorization: 'Bearer token' } });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(sessionChain.is).toHaveBeenCalledWith('consumed_at', null);
    expect(sessionChain.gt).toHaveBeenCalledWith(
      'expires_at',
      expect.any(String),
    );
    sessionChain.maybeSingle.mockResolvedValue({
      data: null,
      error: null,
    } as any);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('requires a challenge ID even for a correctly signed temporary token', async () => {
    const { guard, reflector, sessionChain } = createGuard({
      sub: 'admin-id',
      email: 'admin@example.com',
      tokenType: 'admin-temp',
    });
    reflector.getAllAndOverride.mockReturnValue('admin-temp' as any);
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer token' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessionChain.maybeSingle).not.toHaveBeenCalled();
  });
});
