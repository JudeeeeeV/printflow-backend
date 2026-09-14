import { AuthService } from './auth.service';
import { SupabaseService } from '../supabase/supabase.service';
import { validate } from 'class-validator';
import { RegisterDto } from './dto/register.dto';
import { VerifyEmailOtpDto } from './dto/email-otp.dto';

import { SignupVerificationService } from './signup-verification.service';

const registration = {
  email: 'test@example.com',
  password: 'GoodPassword1!',
  accountType: 'Student',
};

describe('Registration before account creation', () => {
  const send = jest.fn();
  const consume = jest.fn();
  const createUser = jest.fn();
  const rpc = jest.fn();
  const getAdminClient = jest.fn(() => ({
    auth: { admin: { createUser } },
    rpc,
  }));
  const service = new AuthService(
    { getAdminClient } as unknown as SupabaseService,
    { send, consume } as unknown as SignupVerificationService,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    getAdminClient.mockReturnValue({ auth: { admin: { createUser } }, rpc });
  });

  it('only sends a code at registration without creating an Auth user or profile', async () => {
    await expect(service.register(registration)).resolves.toEqual({
      requiresEmailVerification: true,
      email: registration.email,
    });
    expect(send).toHaveBeenCalledWith(registration.email);
    expect(getAdminClient).not.toHaveBeenCalled();
  });
  it('does not create accounts when SMTP fails', async () => {
    send.mockRejectedValue(new Error('SMTP unavailable'));
    await expect(service.register(registration)).rejects.toThrow(
      'SMTP unavailable',
    );
    expect(getAdminClient).not.toHaveBeenCalled();
  });
  it('never creates accounts for invalid, expired or reused codes', async () => {
    consume.mockRejectedValue(new Error('Invalid code'));
    await expect(
      service.verifyEmail({ ...registration, code: '01234567' }),
    ).rejects.toThrow('Invalid code');
    expect(getAdminClient).not.toHaveBeenCalled();
  });
  it('creates the confirmed Auth account and profile only after valid OTP', async () => {
    createUser.mockResolvedValue({
      data: { user: { id: 'new-user', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    rpc.mockResolvedValue({ error: null });
    await expect(
      service.verifyEmail({ ...registration, code: '01234567' }),
    ).resolves.toEqual({ verified: true });
    expect(consume).toHaveBeenCalledWith(registration.email, '01234567');
    expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
      createUser.mock.invocationCallOrder[0],
    );
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email_confirm: true,
        password: registration.password,
      }),
    );
    expect(rpc).toHaveBeenCalledWith('provision_verified_signup', {
      p_user_id: 'new-user',
    });
  });
  it('does not overwrite an account from an earlier signup', async () => {
    createUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Email already registered' },
    });
    await expect(
      service.verifyEmail({ ...registration, code: '01234567' }),
    ).rejects.toThrow('sign in');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('reports profile provisioning failures instead of claiming registration finished', async () => {
    createUser.mockResolvedValue({
      data: { user: { id: 'new-user', email_confirmed_at: '2026-01-01' } },
      error: null,
    });
    rpc.mockResolvedValue({ error: { code: 'TEST_ERROR' } });
    await expect(
      service.verifyEmail({ ...registration, code: '01234567' }),
    ).rejects.toThrow('Try signing in again');
  });
  it('resending only sends a new code and never creates an account', async () => {
    await service.resendCode({ email: registration.email });
    expect(send).toHaveBeenCalledWith(registration.email);
    expect(getAdminClient).not.toHaveBeenCalled();
  });
  it.each(['123456', '123456789', 'abcdefgh'])(
    'rejects malformed code %s',
    async (code) => {
      expect(
        (
          await validate(
            Object.assign(new VerifyEmailOtpDto(), { ...registration, code }),
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it.each(['abcdefgh', 'ABCDEFGH', 'Password1', 'Short1!'])(
    'rejects weak password %s',
    async (password) => {
      expect(
        (
          await validate(
            Object.assign(new RegisterDto(), {
              email: 'test@example.com',
              password,
              accountType: 'Student',
            }),
          )
        ).length,
      ).toBeGreaterThan(0);
    },
  );
  it('accepts a password meeting every requirement', async () => {
    expect(
      await validate(
        Object.assign(new RegisterDto(), {
          email: 'test@example.com',
          password: 'GoodPassword1!',
          accountType: 'Student',
        }),
      ),
    ).toHaveLength(0);
  });
});

describe('Login with RLS enabled', () => {
  it('reads the verified user profile on a separate service-role client', async () => {
    const user = {
      id: 'student-id',
      email: 'test@example.com',
      email_confirmed_at: '2026-01-01',
    };
    const authClient = {
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { user, session: { access_token: 'user-token' } },
          error: null,
        }),
      },
      from: jest.fn(() => {
        throw new Error('RLS blocks profile reads on this signed-in client');
      }),
    };
    const eq = jest
      .fn()
      .mockResolvedValue({ data: [{ role: 'STUDENT' }], error: null });
    const adminClient = {
      from: jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockReturnValue({ eq }) }),
    };
    const getAdminClient = jest
      .fn()
      .mockReturnValueOnce(authClient)
      .mockReturnValueOnce(adminClient);
    const service = new AuthService(
      { getAdminClient } as unknown as SupabaseService,
      {} as SignupVerificationService,
    );
    await expect(
      service.login({ email: user.email, password: 'GoodPassword1!' }),
    ).resolves.toEqual({
      token: 'user-token',
      user: { id: user.id, email: user.email, roleTag: 'Student' },
    });
    expect(authClient.from).not.toHaveBeenCalled();
    expect(adminClient.from).toHaveBeenCalledWith('users');
    expect(eq).toHaveBeenCalledWith('id', user.id);
  });

  it('does not perform a privileged profile lookup when credentials fail', async () => {
    const getAdminClient = jest.fn().mockReturnValue({
      auth: {
        signInWithPassword: jest.fn().mockResolvedValue({
          data: { user: null, session: null },
          error: { message: 'Invalid credentials' },
        }),
      },
    });
    const service = new AuthService(
      { getAdminClient } as unknown as SupabaseService,
      {} as SignupVerificationService,
    );
    await expect(
      service.login({ email: 'test@example.com', password: 'wrong' }),
    ).rejects.toThrow('Invalid credentials');
    expect(getAdminClient).toHaveBeenCalledTimes(1);
  });
});
