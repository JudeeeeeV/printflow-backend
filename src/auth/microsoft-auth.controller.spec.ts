import type { Request, Response } from 'express';
import { MicrosoftAuthController } from './microsoft-auth.controller';
import {
  MicrosoftAuthService,
  MicrosoftLoginError,
} from './microsoft-auth.service';

function fixture() {
  const microsoft = {
    start: jest.fn().mockResolvedValue({
      url: 'https://example.supabase.co/auth/v1/authorize',
      transaction: 'signed-transaction',
    }),
    finish: jest.fn().mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
    }),
    frontendCallback: (error?: string) =>
      `https://frontend.example/auth/microsoft/callback${error ? `?error=${error}` : ''}`,
  };
  const response = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
    setHeader: jest.fn(),
  };
  const controller = new MicrosoftAuthController(
    microsoft as unknown as MicrosoftAuthService,
  );
  const callback = (query: Record<string, unknown>, cookie?: string) =>
    controller.callback(
      { query, headers: { cookie } } as unknown as Request,
      response as unknown as Response,
    );
  return { controller, microsoft, response, callback };
}

describe('MicrosoftAuthController', () => {
  it('sets an HttpOnly, short-lived transaction cookie before redirecting', async () => {
    const f = fixture();
    await f.controller.start(f.response as unknown as Response);
    expect(f.response.cookie).toHaveBeenCalledWith(
      'pf_microsoft_oauth',
      'signed-transaction',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/auth/microsoft',
        maxAge: 600000,
      }),
    );
    expect(f.response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'no-store',
    );
    expect(f.response.redirect).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/authorize',
    );
  });

  it('sets session cookies only after successful validation and never redirects with tokens', async () => {
    const f = fixture();
    await f.callback(
      { code: 'code', state: 'state', next: 'https://attacker.example' },
      'pf_microsoft_oauth=signed-transaction',
    );
    expect(f.microsoft.finish).toHaveBeenCalledWith(
      'code',
      'state',
      'signed-transaction',
    );
    expect(f.response.clearCookie).toHaveBeenCalledWith(
      'pf_microsoft_oauth',
      expect.objectContaining({ path: '/auth/microsoft' }),
    );
    expect(f.response.cookie).toHaveBeenCalledWith(
      'pf_user_access',
      'access-token',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(f.response.cookie).toHaveBeenCalledWith(
      'pf_user_refresh',
      'refresh-token',
      expect.objectContaining({ httpOnly: true }),
    );
    expect(f.response.redirect).toHaveBeenCalledWith(
      'https://frontend.example/auth/microsoft/callback',
    );
  });

  it('rejects callbacks without the originating browser transaction', async () => {
    const f = fixture();
    await f.callback({ code: 'code', state: 'state' });
    expect(f.microsoft.finish).not.toHaveBeenCalled();
    expect(f.response.cookie).not.toHaveBeenCalled();
    expect(f.response.redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=expired'),
    );
  });

  it('handles cancelled consent without creating a session or reflecting provider details', async () => {
    const f = fixture();
    await f.callback({
      error: 'access_denied',
      error_description: 'private provider diagnostic',
    });
    expect(f.microsoft.finish).not.toHaveBeenCalled();
    expect(f.response.cookie).not.toHaveBeenCalled();
    expect(f.response.redirect).toHaveBeenCalledWith(
      'https://frontend.example/auth/microsoft/callback?error=cancelled',
    );
  });

  it('does not set session cookies when CIT validation fails', async () => {
    const f = fixture();
    f.microsoft.finish.mockRejectedValue(new MicrosoftLoginError('cit_only'));
    await f.callback(
      { code: 'code', state: 'state' },
      'pf_microsoft_oauth=signed-transaction',
    );
    expect(f.response.cookie).not.toHaveBeenCalled();
    expect(f.response.redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=cit_only'),
    );
  });
});
