import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { MicrosoftAuthService } from './microsoft-auth.service';
import { SupabaseService } from '../supabase/supabase.service';

const tenant = '12345678-1234-1234-1234-123456789abc';
const secret = 'microsoft-oauth-test-secret-at-least-32-characters';

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function fixture() {
  const config = new ConfigService({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
    JWT_SECRET: secret,
    MICROSOFT_TENANT_ID: tenant,
    MICROSOFT_CALLBACK_URL: 'http://localhost:3000/auth/microsoft/callback',
    FRONTEND_URL: 'http://localhost:5173',
  });
  const user = {
    id: '12345678-1234-1234-1234-123456789aaa',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'student@cit.edu',
    email_confirmed_at: '2026-09-25T00:00:00Z',
    app_metadata: { provider: 'azure' },
    user_metadata: { role: 'MANAGER' },
    identities: [
      {
        id: 'azure-user',
        provider: 'azure',
        identity_data: {
          email: 'student@cit.edu',
          email_verified: true,
          iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
          custom_claims: { tid: tenant, xms_edov: true as unknown },
        },
      },
    ],
  };
  const accessToken = sign({ sub: user.id, role: 'authenticated' }, secret, {
    expiresIn: '1h',
  });
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.includes('/token?grant_type=pkce')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: 'refresh-token',
              expires_in: 3600,
              token_type: 'bearer',
              user,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url.endsWith('/user') && init?.method === 'GET') {
        return Promise.resolve(
          new Response(JSON.stringify(user), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/logout'))
        return Promise.resolve(new Response('{}', { status: 200 }));
      throw new Error(`Unexpected request: ${url}`);
    });
  const upsert = jest.fn().mockResolvedValue({ error: null });
  const updateName = jest.fn().mockResolvedValue({ error: null });
  const updateId = jest.fn().mockReturnValue({ is: updateName });
  const update = jest.fn().mockReturnValue({ eq: updateId });
  const single = jest
    .fn()
    .mockResolvedValue({ data: { role: 'STUDENT' }, error: null });
  const from = jest.fn().mockReturnValue({
    upsert,
    update,
    select: jest
      .fn()
      .mockReturnValue({ eq: jest.fn().mockReturnValue({ single }) }),
  });
  const service = new MicrosoftAuthService(config, {
    getAdminClient: () => ({ from }),
  } as unknown as SupabaseService);
  const begin = async () => {
    const result = await service.start();
    const url = new URL(result.url);
    const state = new URL(
      url.searchParams.get('redirect_to')!,
    ).searchParams.get('state')!;
    return { ...result, state, url };
  };
  return {
    service,
    begin,
    config,
    user,
    fetchMock,
    from,
    upsert,
    single,
    accessToken,
    update,
    updateName,
    updateId,
  };
}

describe('MicrosoftAuthService (real Supabase PKCE client, mocked HTTP)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('saves the CIT email name for an existing Microsoft account without changing its role', async () => {
    const f = fixture();
    f.user.email = 'juan.delacruz@cit.edu';
    f.user.identities[0].identity_data.email = f.user.email;
    f.single.mockResolvedValue({ data: { role: 'CLERK' }, error: null });
    const { state, transaction } = await f.begin();
    await f.service.finish('code', state, transaction);
    expect(f.update).toHaveBeenCalledWith({ first_name: 'Juan' });
    expect(f.update).toHaveBeenCalledWith({ last_name: 'Delacruz' });
    expect(f.updateId).toHaveBeenCalledWith('id', f.user.id);
    expect(f.updateName).toHaveBeenCalledWith('first_name', null);
    expect(f.updateName).toHaveBeenCalledWith('last_name', null);
  });

  it('preserves names edited in account settings on subsequent Microsoft sign-in', async () => {
    const f = fixture();
    f.user.email = 'juan.delacruz@cit.edu';
    f.user.identities[0].identity_data.email = f.user.email;
    f.single.mockResolvedValue({ data: { role: 'STUDENT', first_name: 'Juan Miguel', last_name: 'De la Cruz' }, error: null });
    const { state, transaction } = await f.begin();
    await f.service.finish('code', state, transaction);
    expect(f.update).not.toHaveBeenCalled();
  });

  it('revokes the session if saving the name fails', async () => {
    const f = fixture();
    f.user.email = 'juan.delacruz@cit.edu';
    f.user.identities[0].identity_data.email = f.user.email;
    f.updateName.mockResolvedValue({ error: { message: 'database unavailable' } });
    const { state, transaction } = await f.begin();
    await expect(f.service.finish('code', state, transaction)).rejects.toMatchObject({ code: 'failed' });
    expect(f.fetchMock.mock.calls.some(([url]) => requestUrl(url).includes('/logout?scope=local'))).toBe(true);
  });

  it('binds the browser transaction to an S256 challenge and requests email', async () => {
    const f = fixture();
    const { url, transaction, state } = await f.begin();
    const payload = verify(transaction, secret, {
      audience: 'printflow-microsoft-oauth',
    }) as JwtPayload;
    const verifier = JSON.parse(payload.verifier as string) as string;
    expect(url.searchParams.get('provider')).toBe('azure');
    expect(url.searchParams.get('scopes')).toBe('email');
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    );
    expect(payload.state).toBe(state);
    expect(payload.exp! - payload.iat!).toBe(600);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('exchanges with the original verifier and provisions STUDENT despite editable role metadata', async () => {
    const f = fixture();
    const { state, transaction } = await f.begin();
    await expect(
      f.service.finish('valid-code', state, transaction),
    ).resolves.toEqual({
      accessToken: f.accessToken,
      refreshToken: 'refresh-token',
      expiresIn: 3600,
    });
    const payload = verify(transaction, secret) as JwtPayload;
    const call = f.fetchMock.mock.calls.find(([url]) =>
      requestUrl(url).includes('/token?'),
    )!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      auth_code: 'valid-code',
      code_verifier: JSON.parse(payload.verifier as string) as string,
    });
    expect(f.upsert).toHaveBeenCalledWith(
      { id: f.user.id, email: 'student@cit.edu', role: 'STUDENT' },
      { onConflict: 'id', ignoreDuplicates: true },
    );
  });

  it('keeps an existing shop role instead of overwriting it', async () => {
    const f = fixture();
    f.single.mockResolvedValue({ data: { role: 'CLERK' }, error: null });
    const { state, transaction } = await f.begin();
    await expect(
      f.service.finish('code', state, transaction),
    ).resolves.toBeDefined();
    expect(f.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.user.id }),
      {
        onConflict: 'id',
        ignoreDuplicates: true,
      },
    );
  });

  it.each(['missing', 'tampered', 'state-mismatch', 'expired'])(
    'rejects a %s transaction before making HTTP or database calls',
    async (kind) => {
      const f = fixture();
      const start = await f.begin();
      let transaction = start.transaction;
      if (kind === 'missing') transaction = '';
      if (kind === 'tampered') transaction = `x${transaction}`;
      if (kind === 'expired')
        transaction = sign(
          { state: start.state, verifier: 'verifier' },
          secret,
          { audience: 'printflow-microsoft-oauth', expiresIn: -1 },
        );
      await expect(
        f.service.finish(
          'code',
          kind === 'state-mismatch' ? 'wrong' : start.state,
          transaction,
        ),
      ).rejects.toMatchObject({ code: 'expired' });
      expect(f.fetchMock).not.toHaveBeenCalled();
      expect(f.from).not.toHaveBeenCalled();
    },
  );

  it.each([
    'domain',
    'lookalike-domain',
    'tenant',
    'issuer',
    'provider',
    'unverified',
    'missing-claim',
    'mismatched-email',
  ])(
    'rejects a bad %s identity before provisioning and revokes the session',
    async (kind) => {
      const f = fixture();
      const identity = f.user.identities[0];
      if (kind === 'domain') f.user.email = 'student@outlook.com';
      if (kind === 'lookalike-domain') f.user.email = 'student@fakecit.edu';
      if (kind === 'tenant')
        identity.identity_data.custom_claims.tid = 'other-tenant';
      if (kind === 'issuer')
        identity.identity_data.iss = 'https://attacker.example/v2.0';
      if (kind === 'provider') identity.provider = 'google';
      if (kind === 'unverified') identity.identity_data.email_verified = false;
      if (kind === 'missing-claim')
        identity.identity_data.custom_claims.xms_edov = undefined;
      if (kind === 'mismatched-email')
        identity.identity_data.email = 'other@cit.edu';
      const { state, transaction } = await f.begin();
      await expect(
        f.service.finish('code', state, transaction),
      ).rejects.toMatchObject({ code: 'cit_only' });
      expect(f.from).not.toHaveBeenCalled();
      expect(
        f.fetchMock.mock.calls.some(([url]) =>
          requestUrl(url).includes('/logout?scope=local'),
        ),
      ).toBe(true);
    },
  );

  it('rejects reused or invalid authorization codes without provisioning', async () => {
    const f = fixture();
    const { state, transaction } = await f.begin();
    f.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'Invalid code' }), {
        status: 400,
      }),
    );
    await expect(
      f.service.finish('used-code', state, transaction),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(f.from).not.toHaveBeenCalled();
  });

  it('does not return a session if profile provisioning fails', async () => {
    const f = fixture();
    f.upsert.mockResolvedValue({ error: { message: 'database unavailable' } });
    const { state, transaction } = await f.begin();
    await expect(
      f.service.finish('code', state, transaction),
    ).rejects.toMatchObject({ code: 'failed' });
    expect(
      f.fetchMock.mock.calls.some(([url]) =>
        requestUrl(url).includes('/logout?scope=local'),
      ),
    ).toBe(true);
  });

  it('fails closed until the CIT tenant is configured', async () => {
    const f = fixture();
    f.config.set('MICROSOFT_TENANT_ID', '');
    await expect(f.service.start()).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('requires HTTPS callbacks in production', async () => {
    const f = fixture();
    f.config.set('NODE_ENV', 'production');
    await expect(f.service.start()).rejects.toMatchObject({
      code: 'not_configured',
    });
  });
});
