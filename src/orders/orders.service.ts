import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UploadReceiptDto } from './dto/upload-receipt.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async createOrder(userId: string, payload: CreateOrderDto) {
    const supabase = this.supabaseService.getClient();

    // 1. Create the base order ledger entry
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        client_id: userId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        shop_id: payload.shopId,
        state: 'OPEN_INQUIRY',
        total: 0.0, // In a full implementation, this is calculated via the shop's pricing matrix
      })
      .select()
      .single();

    if (orderError) {
      throw new InternalServerErrorException(
        'Failed to create order ledger entry: ' + orderError.message,
      );
    }

    // 2. Link the design asset to the newly created order
    const { error: assetError } = await supabase.from('assets').insert({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      order_id: order.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      file_url: payload.assetUrl,
      dpi: 300, // Baseline required by application logic
      file_type: 'PDF',
    });

    if (assetError) {
      // Rollback logic could go here if needed
      throw new InternalServerErrorException(
        'Order created, but asset linkage failed: ' + assetError.message,
      );
    }

    return {
      message: 'Order created successfully',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
      orderId: order.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
      state: order.state,
    };
  }

  async uploadReceipt(
    userId: string,
    orderId: string,
    payload: UploadReceiptDto,
  ) {
    const supabase = this.supabaseService.getClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException(
        'Order not found or you do not have permission to access it.',
      );
    }

    if (order.state !== 'OPEN_INQUIRY' && order.state !== 'PROOF_APPROVED') {
      throw new BadRequestException(
        `Cannot upload receipt for an order in ${order.state} state.`,
      );
    }

    // 3. Insert the payment receipt record
    const { error: receiptError } = await supabase
      .from('payment_receipts')
      .insert({
        order_id: orderId,
        uploaded_by: userId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        receipt_url: payload.receiptUrl,
        verified: false,
      });

    if (receiptError) {
      throw new InternalServerErrorException(
        'Failed to upload receipt record: ' + receiptError.message,
      );
    }

    // 4. Transition the order state
    const { error: updateError } = await supabase
      .from('orders')
      .update({ state: 'AWAITING_PAYMENT' })
      .eq('id', orderId);

    if (updateError) {
      throw new InternalServerErrorException(
        'Receipt uploaded, but failed to update order state.',
      );
    }

    return {
      message: 'Receipt uploaded successfully. Awaiting clerk verification.',
      state: 'AWAITING_PAYMENT',
    };
  }
}
