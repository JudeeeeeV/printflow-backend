import { createClient } from '@supabase/supabase-js';

describe('Supabase signup response compatibility', () => {
  const user = {
    id: '12345678-1234-1234-1234-123456789abc',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'signup@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };

  it.each([['flat', user], ['wrapped', { user }]])(
    'preserves the user in a %s signup response with email confirmation enabled',
    async (_shape, body) => {
      const client = createClient('https://example.supabase.co', 'test-key', {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: jest.fn().mockResolvedValue(new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })) },
      });
      const result = await client.auth.signUp({ email: user.email, password: 'ExamplePassword1!' });
      expect(result.error).toBeNull();
      expect(result.data.user?.id).toBe(user.id);
      expect(result.data.session).toBeNull();
    },
  );
});
