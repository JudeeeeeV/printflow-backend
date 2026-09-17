import type { Request, Response } from 'express';

export const USER_ACCESS_COOKIE = 'pf_user_access';
export const USER_REFRESH_COOKIE = 'pf_user_refresh';
export const ADMIN_TEMP_COOKIE = 'pf_admin_temp';
export const ADMIN_ACCESS_COOKIE = 'pf_admin_access';

function commonCookieOptions() {
  const production = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? ('none' as const) : ('lax' as const),
    path: '/',
  };
}

export function setUserCookies(
  response: Response,
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number,
): void {
  const options = commonCookieOptions();
  response.cookie(USER_ACCESS_COOKIE, accessToken, {
    ...options,
    maxAge: Math.max(60, expiresInSeconds) * 1_000,
  });
  response.cookie(USER_REFRESH_COOKIE, refreshToken, {
    ...options,
    maxAge: 30 * 24 * 60 * 60 * 1_000,
  });
}

export function setAdminTempCookie(response: Response, token: string): void {
  response.cookie(ADMIN_TEMP_COOKIE, token, {
    ...commonCookieOptions(),
    maxAge: 15 * 60 * 1_000,
  });
}

export function setAdminAccessCookie(response: Response, token: string): void {
  response.clearCookie(ADMIN_TEMP_COOKIE, commonCookieOptions());
  response.cookie(ADMIN_ACCESS_COOKIE, token, {
    ...commonCookieOptions(),
    maxAge: 15 * 60 * 1_000,
  });
}

export function clearUserCookies(response: Response): void {
  const options = commonCookieOptions();
  response.clearCookie(USER_ACCESS_COOKIE, options);
  response.clearCookie(USER_REFRESH_COOKIE, options);
}

export function clearAdminCookies(response: Response): void {
  const options = commonCookieOptions();
  response.clearCookie(ADMIN_TEMP_COOKIE, options);
  response.clearCookie(ADMIN_ACCESS_COOKIE, options);
}

export function readCookie(
  request: Pick<Request, 'headers'>,
  name: string,
): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function bearerToken(
  request: Pick<Request, 'headers'>,
): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token && token !== 'null' && token !== 'undefined' ? token : undefined;
}
