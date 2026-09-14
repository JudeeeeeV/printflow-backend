import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { SignupVerificationService } from './signup-verification.service';
import { SupabaseService } from '../supabase/supabase.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('Verification email before signup', () => {
  const email = 'test@example.com';
  const secret = 'test-secret-with-at-least-32-characters';
  const config = {
    SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'sender',
    SMTP_PASS: 'test-password', SMTP_FROM: 'PrintFlow <sender@example.com>', SIGNUP_OTP_SECRET: secret,
  };
  const rpc = jest.fn();
  const sendMail = jest.fn();
  const close = jest.fn();
  const service = new SignupVerificationService(new ConfigService(config),
    { getAdminClient: () => ({ rpc }) } as unknown as SupabaseService);
  beforeEach(() => {
    jest.resetAllMocks();
    (createTransport as jest.Mock).mockReturnValue({ sendMail, close });
    rpc.mockResolvedValue({ data: 0, error: null });
    sendMail.mockResolvedValue({ accepted: [email] });
  });

  it('emails exactly 8 digits and stores only the keyed hash', async () => {
    await service.send(email);
    const mail = sendMail.mock.calls[0][0];
    const code = mail.text.match(/code is ([0-9]{8})\./)[1];
    expect(mail.html).toContain(code);
    expect(mail.html).not.toContain('{{ .Token }}');
    expect(rpc).toHaveBeenCalledWith('reserve_signup_code', {
      p_email: email, p_request_id: expect.any(String),
      p_token_hash: createHmac('sha256', secret).update(`${email}:${code}`).digest('hex'),
    });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true }));
    expect(close).toHaveBeenCalled();
  });
  it('uses the server cooldown without sending another email', async () => {
    rpc.mockResolvedValue({ data: 51, error: null });
    await expect(service.send(email)).rejects.toThrow('after 51 seconds');
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('fails closed when verification storage is unavailable', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    await expect(service.send(email)).rejects.toThrow('temporarily unavailable');
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('invalidates only its own code when SMTP fails', async () => {
    sendMail.mockRejectedValue(new Error('SMTP failed'));
    await expect(service.send(email)).rejects.toThrow('could not send');
    const requestId = rpc.mock.calls[0][1].p_request_id;
    expect(rpc).toHaveBeenLastCalledWith('invalidate_signup_code', { p_email: email, p_request_id: requestId });
    expect(close).toHaveBeenCalled();
  });
  it('rejects verification if the database did not consume the code', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(service.consume(email, '01234567')).rejects.toThrow('invalid, expired');
  });
  it('preserves leading zeroes when verifying the hash', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await service.consume(email, '01234567');
    expect(rpc).toHaveBeenCalledWith('consume_signup_code', {
      p_email: email, p_token_hash: createHmac('sha256', secret).update(`${email}:01234567`).digest('hex'),
    });
  });
  it('does not touch the database without SMTP configuration', async () => {
    const unconfigured = new SignupVerificationService(new ConfigService({}),
      { getAdminClient: () => ({ rpc }) } as unknown as SupabaseService);
    await expect(unconfigured.send(email)).rejects.toThrow('not configured');
    expect(rpc).not.toHaveBeenCalled();
  });
});
