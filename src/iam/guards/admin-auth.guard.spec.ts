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
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      single: jest.fn(async () => adminResult),
    };
    const jwtService = { verifyAsync: jest.fn(async () => payload) };
    const reflector = { getAllAndOverride: jest.fn(() => undefined) };
    const supabaseService = {
      getAdminClient: () => ({ from: () => chain }),
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
