import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type User } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { sign, verify } from 'jsonwebtoken';
import { SupabaseService } from '../supabase/supabase.service';

const STORAGE_KEY = 'printflow-microsoft';
const VERIFIER_KEY = `${STORAGE_KEY}-code-verifier`;
const AUDIENCE = 'printflow-microsoft-oauth';

export class MicrosoftLoginError extends Error {
  constructor(
    public readonly code: 'not_configured' | 'expired' | 'cit_only' | 'failed',
  ) {
    super(code);
  }
}

@Injectable()
export class MicrosoftAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  frontendCallback(error?: string): string {
    const url = new URL(
      '/auth/microsoft/callback',
      this.config.get<string>('FRONTEND_URL') || 'http://localhost:5173',
    );
    if (error) url.searchParams.set('error', error);
    return url.toString();
  }

  private settings() {
    const tenant = this.config
      .get<string>('MICROSOFT_TENANT_ID')
      ?.toLowerCase();
    const callback = this.config.get<string>('MICROSOFT_CALLBACK_URL');
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_ANON_KEY');
    const secret = this.config.get<string>('JWT_SECRET');
    if (
      !tenant ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(tenant) ||
      !callback ||
      !url ||
      !key ||
      !secret ||
      secret.length < 32
    ) {
      throw new MicrosoftLoginError('not_configured');
    }
    try {
      const parsed = new URL(callback);
      if (
        parsed.pathname !== '/auth/microsoft/callback' ||
        parsed.search ||
        parsed.hash ||
        parsed.username ||
        parsed.password ||
        (parsed.protocol !== 'https:' &&
          !(
            this.config.get('NODE_ENV') !== 'production' &&
            parsed.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(parsed.hostname)
          ))
      ) {
        throw new Error('Invalid callback');
      }
    } catch {
      throw new MicrosoftLoginError('not_configured');
    }
    return { tenant, callback, url, key, secret };
  }

  private oauthClient(verifier?: string) {
    const { url, key } = this.settings();
    // Per-request memory only. Persisting is enabled so the SDK uses this
    // adapter; only the PKCE verifier is carried between requests in a cookie.
    const storage = new Map<string, string>();
    if (verifier) storage.set(VERIFIER_KEY, verifier);
    const client = createClient(url, key, {
      auth: {
        flowType: 'pkce',
        storageKey: STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => {
            storage.set(key, value);
          },
          removeItem: (key) => {
            storage.delete(key);
          },
        },
      },
    });
    return { client, storage };
  }

  async start() {
    const { callback, secret } = this.settings();
    const state = randomUUID();
    const redirectTo = new URL(callback);
    redirectTo.searchParams.set('state', state);
    const { client, storage } = this.oauthClient();
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: 'email',
        redirectTo: redirectTo.toString(),
        skipBrowserRedirect: true,
        queryParams: { prompt: 'select_account' },
      },
    });
    const verifier = storage.get(VERIFIER_KEY);
    if (error || !data.url || !verifier)
      throw new MicrosoftLoginError('failed');
    return {
      url: data.url,
      transaction: sign({ verifier, state }, secret, {
        algorithm: 'HS256',
        audience: AUDIENCE,
        expiresIn: '10m',
      }),
    };
  }

  private verifyCitIdentity(user: User, tenant: string): void {
    const email = user.email?.trim().toLowerCase();
    const identity = user.identities?.find((item) => item.provider === 'azure');
    // identity_data comes from the provider, unlike editable user_metadata.
    const data: Record<string, unknown> | undefined = identity?.identity_data;
    const claims = data?.custom_claims as Record<string, unknown> | undefined;
    const verifiedDomain = claims?.xms_edov;
    if (
      !email ||
      !/^[^@\s]+@cit\.edu$/.test(email) ||
      !user.email_confirmed_at ||
      data?.email_verified !== true ||
      typeof data.email !== 'string' ||
      data.email.toLowerCase() !== email ||
      data.iss !== `https://login.microsoftonline.com/${tenant}/v2.0` ||
      typeof claims?.tid !== 'string' ||
      claims.tid.toLowerCase() !== tenant ||
      ![true, 'true', '1'].includes(verifiedDomain as boolean | string)
    ) {
      throw new MicrosoftLoginError('cit_only');
    }
  }

  async finish(code: string, state: string, transaction: string) {
    const { secret, tenant } = this.settings();
    let verifier: string;
    try {
      const payload = verify(transaction, secret, {
        algorithms: ['HS256'],
        audience: AUDIENCE,
      });
      if (
        typeof payload === 'string' ||
        payload.state !== state ||
        typeof payload.verifier !== 'string'
      ) {
        throw new Error('Invalid transaction');
      }
      verifier = payload.verifier;
    } catch {
      throw new MicrosoftLoginError('expired');
    }
    const { client } = this.oauthClient(verifier);
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error || !data.session?.access_token || !data.session.refresh_token) {
      throw new MicrosoftLoginError('expired');
    }
    try {
      const { data: verified, error: verificationError } =
        await client.auth.getUser(data.session.access_token);
      if (verificationError || !verified.user)
        throw new MicrosoftLoginError('failed');
      const user = verified.user;
      this.verifyCitIdentity(user, tenant);

      // OAuth users may already be confirmed on INSERT, so the existing
      // email-confirmation UPDATE trigger does not always create their profile.
      // DO NOTHING on conflict preserves existing roles, including shop roles.
      const admin = this.supabase.getAdminClient();
      const { error: insertError } = await admin
        .from('users')
        .upsert(
          { id: user.id, email: user.email, role: 'STUDENT' },
          { onConflict: 'id', ignoreDuplicates: true },
        );
      if (insertError) throw new MicrosoftLoginError('failed');
      const { data: profile, error: profileError } = await admin
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single<{ role: string }>();
      if (
        profileError ||
        !profile ||
        !['STUDENT', 'CLERK', 'MANAGER'].includes(profile.role)
      ) {
        throw new MicrosoftLoginError('failed');
      }
      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in || 3600,
      };
    } catch (error) {
      await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
      throw error;
    }
  }
}
