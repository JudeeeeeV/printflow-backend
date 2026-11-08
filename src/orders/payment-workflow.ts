import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { PostgrestSingleResponse } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { OrderDecisionUnavailableException } from '../common/order-decision-unavailable.exception';

export type PaymentMethod = 'GCASH' | 'CASH_ON_PICKUP';

export interface PaymentOrder {
  id: string;
  state: string;
  payment_method: PaymentMethod;
  payment_status: string;
  acceptance_status: string;
  current_receipt_id: string | null;
  [key: string]: unknown;
}

const paymentLogger = new Logger('PaymentWorkflow');

export function throwPaymentError(
  error: { code?: string; message?: string; details?: string },
  context: {
    httpStatus?: number;
    timedOut?: boolean;
    durationMs?: number;
  } = {},
): never {
  const transportCode = [
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ].find((code) =>
    `${error.code || ''} ${error.message || ''} ${error.details || ''}`.includes(
      code,
    ),
  );
  if (
    context.timedOut ||
    context.httpStatus === 0 ||
    transportCode ||
    (!error.code && (context.httpStatus || 0) >= 500)
  ) {
    const code = context.timedOut
      ? 'REQUEST_TIMEOUT'
      : transportCode || 'UPSTREAM_UNAVAILABLE';
    paymentLogger.error(
      `Order decision connection failed [code=${code}, httpStatus=${context.httpStatus ?? 0}, durationMs=${context.durationMs ?? 0}].`,
    );
    throw new OrderDecisionUnavailableException();
  }
  if (error.code === '55P03') {
    throw new ConflictException(
      'Another action is updating this order. Refresh its status and try again shortly.',
    );
  }
  if (error.code === '40001' || error.code === '23505') {
    throw new ConflictException(
      'The order or receipt changed. Refresh and review it before trying again.',
    );
  }
  if (error.code === '42501') {
    if (
      /^permission denied for (function|schema|table|sequence)\b/i.test(
        error.message || '',
      )
    ) {
      // Log only fixed configuration guidance, never raw database details,
      // request bodies, receipt references, or authentication credentials.
      paymentLogger.error(
        'Payment database permission denied. Check the service-role client and payment migration grants.',
      );
      throw new ServiceUnavailableException(
        'Payment actions are temporarily unavailable due to a server configuration issue. Please contact support.',
      );
    }
    throw new ForbiddenException(
      'This action is not permitted for your account.',
    );
  }
  if (error.code === 'P0002') throw new NotFoundException('Order not found.');
  if (error.code === '23514' && ['SHOP_NOT_VERIFIED', 'DOCUMENT_NOT_VALID'].includes(error.details || '')) {
    throw new ConflictException(error.details === 'SHOP_NOT_VERIFIED'
      ? 'The shop must be verified before authorizing production.'
      : 'A valid stored document is required before verifying payment. Restore it and retry.');
  }
  if (error.code === '23514' || error.code === '22P02') {
    throw new BadRequestException(
      'Check the order eligibility, required reason/reference, and confirmation.',
    );
  }
  // Preserve a useful diagnostic without logging database messages, SQL,
  // document paths, receipt references, or request payloads.
  const code = /^(?:[A-Z0-9]{5}|PGRST\d{3})$/.test(error.code || '')
    ? error.code
    : 'UNKNOWN';
  paymentLogger.error(`Order decision database request failed [code=${code}].`);
  throw new InternalServerErrorException(
    'The order decision could not be saved.',
  );
}

export async function applyOrderDecision(
  supabaseService: SupabaseService,
  orderId: string,
  actorId: string | null,
  actorType: 'STUDENT' | 'SHOP' | 'ADMIN' | 'SYSTEM',
  action: string,
  data: Record<string, unknown> = {},
): Promise<PaymentOrder> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const startedAt = Date.now();
  let result: PostgrestSingleResponse<unknown>;
  try {
    result = await supabaseService
      .getAdminClient()
      .rpc('apply_order_decision', {
        p_order: orderId,
        p_actor: actorId,
        p_actor_type: actorType,
        p_action: action,
        p_data: data,
      })
      .abortSignal(controller.signal);
  } catch {
    paymentLogger.error(
      'Order decision connection failed before a response was received.',
    );
    throw new OrderDecisionUnavailableException();
  } finally {
    clearTimeout(timeout);
  }
  if (result.error)
    throwPaymentError(result.error, {
      httpStatus: result.status,
      timedOut: controller.signal.aborted,
      durationMs: Date.now() - startedAt,
    });
  if (!result.data || typeof result.data !== 'object') {
    throw new InternalServerErrorException(
      'The order decision returned no result.',
    );
  }
  return result.data as PaymentOrder;
}
