import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, catchError, concatMap, from, map, throwError } from 'rxjs';
import { AdminAuditService } from './admin-audit.service';

type AdminRequest = Request & {
  user?: { sub?: string };
  requestId?: string;
};

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const actorId = request.user?.sub;
    if (!actorId) return next.handle();

    const action = `${request.method} ${request.path}`;
    const rawTargetId = request.params?.id;
    const targetId = Array.isArray(rawTargetId) ? rawTargetId[0] : rawTargetId;
    const targetType = request.path.includes('/orders/')
      ? 'order'
      : request.path.includes('/shops/')
        ? 'shop'
        : request.path.includes('/daemon-devices/')
          ? 'daemon_device'
          : undefined;
    const baseEvent = {
      actorId,
      action,
      targetType,
      targetId,
      requestId: request.requestId || 'unknown',
      sourceIp: request.ip,
    };

    return next.handle().pipe(
      concatMap((value) =>
        from(this.audit.record({ ...baseEvent, outcome: 'SUCCESS' })).pipe(
          map(() => value),
        ),
      ),
      catchError((error: unknown) => {
        return from(
          this.audit.record({ ...baseEvent, outcome: 'FAILURE' }),
        ).pipe(concatMap(() => throwError(() => error)));
      }),
    );
  }
}
