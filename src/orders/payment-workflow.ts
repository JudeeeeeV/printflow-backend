import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

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

export function throwPaymentError(error: { code?: string }): never {
  if (error.code === '40001' || error.code === '23505') {
    throw new ConflictException(
      'The order or receipt changed. Refresh and review it before trying again.',
    );
  }
  if (error.code === '42501')
    throw new ForbiddenException(
      'This action is not permitted for your account.',
    );
  if (error.code === 'P0002') throw new NotFoundException('Order not found.');
  if (error.code === '23514' || error.code === '22P02') {
    throw new BadRequestException(
      'Check the order eligibility, required reason/reference, and confirmation.',
    );
  }
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
  const result = await supabaseService
    .getAdminClient()
    .rpc('apply_order_decision', {
      p_order: orderId,
      p_actor: actorId,
      p_actor_type: actorType,
      p_action: action,
      p_data: data,
    });
  if (result.error) throwPaymentError(result.error);
  if (!result.data || typeof result.data !== 'object') {
    throw new InternalServerErrorException(
      'The order decision returned no result.',
    );
  }
  return result.data as PaymentOrder;
}
