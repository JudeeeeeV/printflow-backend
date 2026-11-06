import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { applyOrderDecision } from './payment-workflow';
import { SupabaseService } from '../supabase/supabase.service';
import { OrderDecisionDto } from './dto/order-decision.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { UploadReceiptDto } from './dto/upload-receipt.dto';

describe('payment decision RPC boundary', () => {
  const order = {
    id: 'order',
    state: 'OPEN_INQUIRY',
    payment_status: 'VERIFIED',
    acceptance_status: 'PENDING',
  };
  it('binds actor, order, action and receipt without inferring production from payment', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: order, error: null });
    const service = {
      getAdminClient: () => ({ rpc }),
    } as unknown as SupabaseService;
    const result = await applyOrderDecision(
      service,
      'order',
      'clerk',
      'SHOP',
      'VERIFY',
      { receiptId: 'current', confirmed: true },
    );
    expect(rpc).toHaveBeenCalledWith('apply_order_decision', {
      p_order: 'order',
      p_actor: 'clerk',
      p_actor_type: 'SHOP',
      p_action: 'VERIFY',
      p_data: { receiptId: 'current', confirmed: true },
    });
    expect(result).toEqual(order);
    expect(result.acceptance_status).toBe('PENDING');
    expect(result.state).toBe('OPEN_INQUIRY');
  });
  it.each([
    ['40001', ConflictException],
    ['23505', ConflictException],
    ['42501', ForbiddenException],
    ['P0002', NotFoundException],
    ['23514', BadRequestException],
  ])(
    'maps database code %s to a safe application error',
    async (code, exception) => {
      const service = {
        getAdminClient: () => ({
          rpc: jest.fn().mockResolvedValue({
            error: { code, message: 'internal database detail' },
          }),
        }),
      } as unknown as SupabaseService;
      await expect(
        applyOrderDecision(service, 'order', 'actor', 'SHOP', 'ACCEPT'),
      ).rejects.toBeInstanceOf(exception);
      await expect(
        applyOrderDecision(service, 'order', 'actor', 'SHOP', 'ACCEPT'),
      ).rejects.not.toThrow('internal database detail');
    },
  );
  it('does not accept client actor identities, lifecycle shortcuts, or missing receipt identity', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform({}, { type: 'body', metatype: UploadReceiptDto }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { referenceNumber: '   ' },
        { type: 'body', metatype: UploadReceiptDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { action: 'ACCEPT', actorId: 'another-user' },
        { type: 'body', metatype: OrderDecisionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { action: 'COMPLETED' },
        { type: 'body', metatype: OrderDecisionDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform(
        { action: 'APPROVE', confirmed: true },
        { type: 'body', metatype: VerifyPaymentDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
