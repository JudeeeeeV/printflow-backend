import { UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { SupabaseService } from '../supabase/supabase.service';
import type { Response, Request } from 'express';

describe('Auth dual-token & cookie fallback', () => {
  let authService: jest.Mocked<Partial<AuthService>>;
  let controller: AuthController;

  const mockResponse = () => {
    const res: Partial<Response> = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };
    return res as Response;
  };

  beforeEach(() => {
    authService = {
      login: jest.fn().mockResolvedValue({
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresIn: 3600,
        user: { id: 'u1', email: 'test@example.com', roleTag: 'Student' },
      }),
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        expiresIn: 3600,
        user: { id: 'u1', email: 'test@example.com', roleTag: 'Student' },
      }),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AuthController(authService as AuthService, { assertHuman: jest.fn() } as never);
  });

  it('login returns token and refreshToken even in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = mockResponse();
      const result = await controller.login(
        { email: 'test@example.com', password: 'Password123!' },
        res,
      );

      expect(result).toEqual({
        user: { id: 'u1', email: 'test@example.com', roleTag: 'Student' },
        token: 'access-123',
        refreshToken: 'refresh-456',
      });
      expect(res.cookie).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('refresh accepts refreshToken from request body when cookie is missing', async () => {
    const req = { headers: {} } as Request;
    const res = mockResponse();

    const result = await controller.refresh(req, res, {
      refreshToken: 'body-refresh-token',
    });

    expect(authService.refresh).toHaveBeenCalledWith('body-refresh-token');
    expect(result).toEqual({
      user: { id: 'u1', email: 'test@example.com', roleTag: 'Student' },
      token: 'access-new',
      refreshToken: 'refresh-new',
    });
    expect(res.cookie).toHaveBeenCalled();
  });

  it('refresh rejects when neither cookie nor body refreshToken exists', async () => {
    const req = { headers: {} } as Request;
    const res = mockResponse();

    await expect(controller.refresh(req, res, {})).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('GET /auth/login redirects to frontend auth page', () => {
    const res = mockResponse();
    controller.loginPage(res);
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringMatching(/\/auth$/),
    );
  });

  it('SupabaseAuthGuard accepts query param token for SSE', async () => {
    const supabase = {
      getAdminClient: () => ({
        auth: {
          getUser: jest.fn().mockResolvedValue({
            data: { user: { id: 'u1', email: 'test@example.com' } },
            error: null,
          }),
        },
        from: () => ({
          select: () => ({
            eq: () => ({
              single: jest.fn().mockResolvedValue({
                data: { role: 'STUDENT' },
                error: null,
              }),
            }),
          }),
        }),
      }),
    };
    const guard = new SupabaseAuthGuard(supabase as unknown as SupabaseService);
    const req: any = {
      headers: {},
      query: { token: 'sse-query-token' },
    };
    const context: any = {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    };

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(req.user).toEqual({
      id: 'u1',
      email: 'test@example.com',
      role: 'STUDENT',
    });
  });

  it('SupabaseAuthGuard throws 401 when no token is present', async () => {
    const guard = new SupabaseAuthGuard({} as unknown as SupabaseService);
    const req: any = { headers: {}, query: {} };
    const context: any = {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    };

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Missing or invalid Authorization header',
    );
  });
});
