import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateOrderDto } from './dto/create-order.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredOrders() {
    const supabase = this.supabaseService.getAdminClient();
    const expiryTime = new Date(Date.now() - 15 * 60000).toISOString();
    
    const { data, error } = await supabase
      .from('orders')
      .delete()
      .eq('state', 'OPEN_INQUIRY')
      .lt('created_at', expiryTime)
      .select('id');

    if (error) {
      this.logger.error('Failed to cleanup expired orders: ' + error.message);
    } else if (data && data.length > 0) {
      this.logger.log(`Cleaned up ${data.length} expired orders.`);
    }
  }

  async getUserOrders(userId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*, shops(name)')
      .eq('client_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch orders: ' + error.message);
    }
    return data;
  }

  async getShopOrders(shopId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*, payment_receipts(*)')
      .eq('shop_id', shopId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch shop orders: ' + error.message);
    }
    return data;
  }

  async getOrder(userId: string, orderId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*, shops(name), payment_receipts(*)')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Order not found');
    }
    return data;
  }

  async createOrder(userId: string, payload: CreateOrderDto) {
    const supabase = this.supabaseService.getAdminClient();

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

  async ensureReceiptsBucket() {
    const supabase = this.supabaseService.getAdminClient();
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      this.logger.error("Error listing buckets:", listError);
      throw new InternalServerErrorException(`Failed to list buckets: ${listError.message}`);
    }
    if (!buckets?.find(b => b.name === 'receipts')) {
      const { error: createError } = await supabase.storage.createBucket('receipts', { public: true });
      if (createError) throw new InternalServerErrorException(`Failed to create receipts bucket: ${createError.message}`);
    }
  }

  async submitPaymentReceipt(
    userId: string,
    orderId: string,
    file: Express.Multer.File,
    referenceNumber?: string
  ) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state, shop_id')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found or you do not have permission to access it.');
    }

    if (order.state !== 'PROOF_APPROVED' && order.state !== 'AWAITING_PAYMENT' && order.state !== 'OPEN_INQUIRY') {
      throw new BadRequestException(`Cannot upload receipt for an order in ${order.state} state.`);
    }

    // Assume bucket exists. User should create it in Supabase Dashboard.

    const fileName = `${orderId}-${Date.now()}-${file.originalname}`;
    const { error: uploadError } = await supabase.storage.from('receipts').upload(fileName, file.buffer, {
      contentType: file.mimetype,
    });

    if (uploadError) {
      throw new InternalServerErrorException(`Failed to upload receipt image: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage.from('receipts').getPublicUrl(fileName);
    const receiptUrl = urlData.publicUrl;

    const { error: receiptError } = await supabase.from('payment_receipts').insert({
      order_id: orderId,
      uploaded_by: userId,
      receipt_url: receiptUrl,
      reference_number: referenceNumber || null,
      verified: false,
    });

    if (receiptError) {
      throw new InternalServerErrorException('Failed to upload receipt record: ' + receiptError.message);
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({ state: 'AWAITING_PAYMENT_VERIFICATION' })
      .eq('id', orderId);

    if (updateError) {
      throw new InternalServerErrorException('Receipt uploaded, but failed to update order state.');
    }

    // Assign notification to the shop ID (clerk_id)
    await supabase.from('notifications').insert({
      order_id: orderId,
      clerk_id: order.shop_id,
    });

    return {
      message: 'Receipt uploaded successfully. Awaiting verification.',
      state: 'AWAITING_PAYMENT_VERIFICATION',
    };
  }

  async verifyPayment(clerkId: string, orderId: string, action: 'APPROVE' | 'REJECT', reason?: string) {
    const supabase = this.supabaseService.getAdminClient();

    // In a real app we might verify if clerkId belongs to the shop that owns the order
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found.');
    }

    if (order.state !== 'AWAITING_PAYMENT_VERIFICATION') {
      throw new BadRequestException('Order is not awaiting payment verification.');
    }

    if (action === 'APPROVE') {
      await supabase.from('payment_receipts')
        .update({ verified: true })
        .eq('order_id', orderId);

      const { error: updateError } = await supabase.from('orders')
        .update({ state: 'IN_PRODUCTION' })
        .eq('id', orderId);

      if (updateError) throw new InternalServerErrorException('Failed to update order state.');
      
      // Clear notifications
      await supabase.from('notifications')
        .update({ is_read: true })
        .eq('order_id', orderId);

      return { message: 'Payment approved. Order is now in production.' };
    } else {
      // REJECT
      const { error: updateError } = await supabase.from('orders')
        .update({ state: 'AWAITING_PAYMENT' })
        .eq('id', orderId);

      if (updateError) throw new InternalServerErrorException('Failed to update order state.');

      // Clear notifications
      await supabase.from('notifications')
        .update({ is_read: true })
        .eq('order_id', orderId);
        
      return { message: 'Payment rejected. Client has been notified to re-upload.' };
    }
  }

  async cancelOrder(userId: string, orderId: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found or access denied.');
    }

    const { error: deleteError } = await supabase
      .from('orders')
      .delete()
      .eq('id', orderId)
      .eq('client_id', userId);

    if (deleteError) {
      throw new InternalServerErrorException(
        'Failed to cancel order: ' + deleteError.message,
      );
    }

    return { message: 'Order cancelled successfully' };
  }
}
