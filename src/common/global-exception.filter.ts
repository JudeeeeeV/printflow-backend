import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { OrderDecisionUnavailableException } from './order-decision-unavailable.exception';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { requestId?: string }>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const requestId = request.requestId || 'unknown';

    if (status >= 500) {
      const diagnostic =
        exception instanceof Error
          ? exception.stack || exception.message
          : String(exception);
      this.logger.error(
        `${request.method} ${request.path} failed [requestId=${requestId}]: ${diagnostic}`,
      );
      response.status(status).json({
        statusCode: status,
        message:
          exception instanceof OrderDecisionUnavailableException
            ? exception.message
            : 'An internal error occurred',
        requestId,
      });
      return;
    }

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : null;
    const body =
      typeof exceptionResponse === 'string'
        ? { statusCode: status, message: exceptionResponse }
        : { ...(exceptionResponse as object), statusCode: status };
    response.status(status).json({ ...body, requestId });
  }
}
