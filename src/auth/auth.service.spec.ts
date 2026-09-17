import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('AuthService', () => {
  it('returns the authenticated user with the database-backed role', async () => {
    const user = {
      id: 'student-id',
      email: 'student@example.com',
      email_confirmed_at: '2026-01-01',
    };
    const authClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: {
            user,
            session: {
              access_token: 'user-token',
              refresh_token: 'refresh-token',
              expires_in: 3600,
            },
          },
          error: null,
        }),
      },
    };
    const eq = jest
      .fn()
      .mockResolvedValue({ data: [{ role: 'STUDENT' }], error: null });
    const profileClient = {
      from: jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockReturnValue({ eq }) }),
    };
    const getAdminClient = jest
      .fn()
      .mockReturnValueOnce(authClient)
      .mockReturnValueOnce(profileClient);
    const service = new AuthService({
      getAdminClient,
    } as unknown as SupabaseService);

    await expect(
      service.login({ email: user.email, password: 'GoodPassword1!' }),
    ).resolves.toEqual({
      accessToken: 'user-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: { id: user.id, email: user.email, roleTag: 'Student' },
    });
    expect(profileClient.from).toHaveBeenCalledWith('users');
    expect(eq).toHaveBeenCalledWith('id', user.id);
  });

  it('does not query a privileged profile when credentials fail', async () => {
    const getAdminClient = jest.fn().mockReturnValue({
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: { message: 'Invalid credentials' },
        }),
      },
    });
    const service = new AuthService({
      getAdminClient,
    } as unknown as SupabaseService);

    await expect(
      service.login({ email: 'student@example.com', password: 'wrong' }),
    ).rejects.toThrow('Invalid credentials');
    expect(getAdminClient).toHaveBeenCalledTimes(1);
  });
});
