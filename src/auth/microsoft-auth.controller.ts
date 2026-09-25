import { Controller, Get, Logger, Request, Response } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { readCookie, setUserCookies } from './auth-cookies';
import {
  MicrosoftAuthService,
  MicrosoftLoginError,
} from './microsoft-auth.service';

const TRANSACTION_COOKIE = 'pf_microsoft_oauth';
const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/auth/microsoft',
});

@Controller('auth/microsoft')
export class MicrosoftAuthController {
  private readonly logger = new Logger(MicrosoftAuthController.name);
  constructor(private readonly microsoft: MicrosoftAuthService) {}

  @Get()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async start(@Response() response: ExpressResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const { url, transaction } = await this.microsoft.start();
      response.cookie(TRANSACTION_COOKIE, transaction, {
        ...cookieOptions(),
        maxAge: 10 * 60_000,
      });
      return response.redirect(url);
    } catch (error) {
      return this.failure(response, error);
    }
  }

  @Get('callback')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async callback(
    @Request() request: ExpressRequest,
    @Response() response: ExpressResponse,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.clearCookie(TRANSACTION_COOKIE, cookieOptions());
    try {
      const { code, state, error } = request.query;
      if (error) {
        return response.redirect(
          this.microsoft.frontendCallback(
            error === 'access_denied' ? 'cancelled' : 'failed',
          ),
        );
      }
      const transaction = readCookie(request, TRANSACTION_COOKIE);
      if (
        typeof code !== 'string' ||
        !code ||
        code.length > 2048 ||
        typeof state !== 'string' ||
        !state ||
        !transaction
      ) {
        throw new MicrosoftLoginError('expired');
      }
      const session = await this.microsoft.finish(code, state, transaction);
      setUserCookies(
        response,
        session.accessToken,
        session.refreshToken,
        session.expiresIn,
      );
      return response.redirect(this.microsoft.frontendCallback());
    } catch (error) {
      return this.failure(response, error);
    }
  }

  private failure(response: ExpressResponse, error: unknown) {
    const code = error instanceof MicrosoftLoginError ? error.code : 'failed';
    // Avoid logging callback codes, tokens, provider errors, or account details.
    this.logger.warn(`Microsoft sign-in failed: ${code}`);
    response.clearCookie(TRANSACTION_COOKIE, cookieOptions());
    return response.redirect(this.microsoft.frontendCallback(code));
  }
}
