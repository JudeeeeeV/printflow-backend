import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly config: ConfigService) {}

  // Supabase skips CAPTCHA for service-role requests, so backend logins are
  // verified here. Without a secret the check stays off for a staged rollout.
  async assertHuman(token: string | undefined): Promise<void> {
    const secret = this.config.get<string>('TURNSTILE_SECRET_KEY');
    if (!secret) return;
    if (!token) {
      throw new BadRequestException('Please complete the security check.');
    }

    let success: boolean | undefined;
    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: token }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      ({ success } = (await response.json()) as { success?: boolean });
    } catch {
      this.logger.error('Could not reach the Turnstile verification service.');
      throw new ServiceUnavailableException(
        'The security check is temporarily unavailable. Please try again.',
      );
    }

    if (success !== true) {
      throw new BadRequestException(
        'The security check failed. Please complete it again.',
      );
    }
  }
}
