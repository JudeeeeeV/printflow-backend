import {
  ArgumentsHost,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { OrderDecisionUnavailableException } from './order-decision-unavailable.exception';

describe('GlobalExceptionFilter server errors', () => {
  afterEach(() => jest.restoreAllMocks());

  function respond(exception: unknown) {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/orders/order/decision',
          requestId: 'request',
        }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    new GlobalExceptionFilter().catch(exception, host);
    return response;
  }

  it('exposes the fixed guidance for an uncertain order decision', () => {
    const exception = new OrderDecisionUnavailableException();
    const response = respond(exception);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 503,
      message: exception.message,
      requestId: 'request',
    });
  });

  it.each([
    new InternalServerErrorException('Private implementation detail'),
    new ServiceUnavailableException('Private upstream detail'),
    new Error('Private internal detail'),
  ])('continues hiding other server error messages', (exception) => {
    const response = respond(exception);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: exception instanceof ServiceUnavailableException ? 503 : 500,
      message: 'An internal error occurred',
      requestId: 'request',
    });
  });
});
