import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import { TurnstileService } from './turnstile.service';

const serviceWith = (secret?: string) =>
  new TurnstileService({
    get: () => secret,
  } as unknown as ConfigService);

describe('TurnstileService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const respond = (body: unknown) =>
    fetchMock.mockResolvedValue({ json: () => Promise.resolve(body) });

  it('stays off until a secret is configured', async () => {
    await expect(serviceWith().assertHuman(undefined)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a token without contacting Cloudflare', async () => {
    await expect(serviceWith('secret').assertHuman(undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a token Cloudflare confirms and sends the secret only there', async () => {
    respond({ success: true });
    await expect(
      serviceWith('secret').assertHuman('token'),
    ).resolves.toBeUndefined();
    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(JSON.parse(options.body)).toEqual({
      secret: 'secret',
      response: 'token',
    });
  });

  it.each([[{ success: false }], [{}], [null]])(
    'rejects an unconfirmed response: %j',
    async (body) => {
      respond(body ?? {});
      await expect(serviceWith('secret').assertHuman('token')).rejects.toThrow(
        BadRequestException,
      );
    },
  );

  it('fails closed when Cloudflare cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(serviceWith('secret').assertHuman('token')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('AuthController login security check', () => {
  it('does not try the password when the security check fails', async () => {
    const authService = { login: jest.fn() };
    const turnstile = {
      assertHuman: jest
        .fn()
        .mockRejectedValue(new BadRequestException('failed')),
    };
    const controller = new AuthController(
      authService as unknown as AuthService,
      turnstile as unknown as TurnstileService,
    );

    await expect(
      controller.login(
        {
          email: 'test@example.com',
          password: 'Password123!',
          captchaToken: 'bad',
        },
        {} as ExpressResponse,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(turnstile.assertHuman).toHaveBeenCalledWith('bad');
    expect(authService.login).not.toHaveBeenCalled();
  });
});
