import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promises as dns } from 'node:dns';
import { createTransport } from 'nodemailer';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class SignupVerificationService {
  private readonly logger = new Logger(SignupVerificationService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  private hash(email: string, code: string) {
    const secret = this.config.get<string>('SIGNUP_OTP_SECRET');
    if (!secret || secret.length < 32) {
      this.logger.error(
        'Set SIGNUP_OTP_SECRET to a random secret of at least 32 characters.',
      );
      throw new ServiceUnavailableException(
        'Email verification is not configured yet. Please try again later.',
      );
    }
    return createHmac('sha256', secret)
      .update(`${email}:${code}`)
      .digest('hex');
  }

  async send(email: string) {
    const host = this.config.get<string>('SMTP_HOST');
    const username = this.config.get<string>('SMTP_USER');
    const password = this.config.get<string>('SMTP_PASS');
    const from = this.config.get<string>('SMTP_FROM');
    const port = Number(this.config.get<string>('SMTP_PORT') || 587);
    if (
      !host ||
      !username ||
      !password ||
      !from ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      this.logger.error(
        'Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in the backend environment.',
      );
      throw new ServiceUnavailableException(
        'Verification email delivery is not configured yet. Please try again later.',
      );
    }
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const tokenHash = this.hash(email, code);
    // Use the same branded template; never put the raw code in logs or database rows.
    let html: string;
    try {
      html = (
        await readFile(
          resolve(process.cwd(), 'supabase/templates/confirm-signup.html'),
          'utf8',
        )
      ).replace(/\{\{\s*\.Token\s*\}\}/g, code);
    } catch {
      this.logger.error('The signup email HTML template could not be read.');
      throw new ServiceUnavailableException(
        'Verification email is unavailable. Please try again later.',
      );
    }
    const client = this.supabase.getAdminClient();
    const requestId = randomUUID();
    const { data: wait, error } = await client.rpc('reserve_signup_code', {
      p_email: email,
      p_request_id: requestId,
      p_token_hash: tokenHash,
    });
    if (error || typeof wait !== 'number') {
      this.logger.error(
        `Cannot reserve signup code (database code: ${error?.code || 'unexpected response'}). Apply the signup verification migration.`,
      );
      throw new ServiceUnavailableException(
        'Email verification is temporarily unavailable. Please try again later.',
      );
    }
    if (wait > 0) {
      throw new HttpException(
        `Please wait ${wait} seconds before requesting another code.`,
        429,
      );
    }
    const resendKey = this.config.get<string>('RESEND_API_KEY');
    if (!resendKey) {
      this.logger.error('Configure RESEND_API_KEY in the backend environment.');
      throw new ServiceUnavailableException('Verification email delivery is not configured yet. Please try again later.');
    }

    const { Resend } = await import('resend');
    const resend = new Resend(resendKey);

    try {
      const { error: resendError } = await resend.emails.send({
        from: 'PrintFlow <onboarding@resend.dev>',
        to: email,
        subject: 'Your PrintFlow verification code',
        html,
        text: `Your PrintFlow verification code is ${code}. Enter it on the registration screen. It expires in 10 minutes and can be used once. If you did not request this code, ignore this email.`,
      });
      if (resendError) {
        throw new Error(resendError.message);
      }
    } catch (e: any) {
      await client.rpc('invalidate_signup_code', {
        p_email: email,
        p_request_id: requestId,
      });
      this.logger.error(`Signup Resend delivery failed: ${e.message}`, e.stack);
      throw new ServiceUnavailableException(
        `Resend Error: ${e.message}`,
      );
    }
  }

  async consume(email: string, code: string) {
    const { data, error } = await this.supabase
      .getAdminClient()
      .rpc('consume_signup_code', {
        p_email: email,
        p_token_hash: this.hash(email, code),
      });
    if (error) {
      this.logger.error(
        `Cannot verify signup code (database code: ${error.code}).`,
      );
      throw new ServiceUnavailableException(
        'Email verification is temporarily unavailable. Please try again later.',
      );
    }
    if (data !== true) {
      throw new BadRequestException(
        'The code is invalid, expired, already used, or has too many failed attempts. Request a new code.',
      );
    }
  }
}
