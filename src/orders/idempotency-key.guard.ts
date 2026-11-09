import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OperationKeyRequest = Request & { operationKey?: string };

/** Runs before upload interceptors so a bad request never pays for its body. */
@Injectable()
export class IdempotencyKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OperationKeyRequest>();
    const header = request.headers['idempotency-key'];
    if (typeof header === 'string') {
      if (!UUID_PATTERN.test(header))
        throw new BadRequestException('Invalid Idempotency-Key header.');
      request.operationKey = header.toLowerCase();
      return true;
    }
    if (process.env.REQUIRE_IDEMPOTENCY_KEY === 'true') {
      throw new HttpException(
        {
          code: 'REFRESH_REQUIRED',
          message: 'Refresh this page to continue with the latest version.',
        },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    // Older clients keep working during rollout, without replay protection.
    request.operationKey = randomUUID();
    return true;
  }
}
