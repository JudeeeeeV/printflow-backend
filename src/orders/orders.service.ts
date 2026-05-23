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
      .neq('state', 'DRAFT')
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
      .select('*, payment_receipts(*), assets(*)')
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
      .select('*, shops(name, gcash_qr_url), payment_receipts(*)')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Order not found');
    }
    return data;
  }

  async getDrafts(userId: string) {
    const supabase = this.supabaseService.getAdminClient();
    
    const { data, error } = await supabase
      .from('orders')
      .select('id, total, created_at, shops(name), assets(file_url)')
      .eq('client_id', userId)
      .eq('state', 'DRAFT') 
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException('Failed to fetch drafts: ' + error.message);
    }

    return data.map((order: any) => {
      // Extract the original filename from the Supabase storage URL
      let fileName = 'Design File';
      if (order.assets && order.assets.length > 0 && order.assets[0].file_url) {
        const urlParts = order.assets[0].file_url.split('/');
        fileName = decodeURIComponent(urlParts[urlParts.length - 1]);
      }

      return {
        id: order.id,
        shopName: order.shops?.name || 'Unknown Shop',
        fileName: fileName,
        total: order.total,
        updatedAt: order.created_at, // Map created_at to the frontend's updatedAt
      };
    });
  }

  async submitDraft(userId: string, draftId: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', draftId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Draft not found');
    }

    if (order.state !== 'DRAFT') {
      throw new BadRequestException('Order is not a draft.');
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({ 
        state: 'OPEN_INQUIRY',
        created_at: new Date().toISOString() // This resets the 15-minute clock!
      })
      .eq('id', draftId);

    if (updateError) {
      throw new InternalServerErrorException('Failed to submit draft: ' + updateError.message);
    }

    return { message: 'Draft submitted successfully', orderId: draftId };
  }

  async deleteDraft(userId: string, draftId: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { error: deleteError } = await supabase
      .from('orders')
      .delete()
      .eq('id', draftId)
      .eq('client_id', userId)
      .eq('state', 'DRAFT'); // Ensure only drafts can be deleted via this method

    if (deleteError) {
      throw new InternalServerErrorException('Failed to delete draft: ' + deleteError.message);
    }

    return { message: 'Draft deleted successfully' };
  }

  async createOrder(userId: string, payload: CreateOrderDto, file: Express.Multer.File) {
    const supabase = this.supabaseService.getAdminClient();
    
    // Evaluate the string sent by FormData
    const isDraftOrder = payload.isDraft === 'true';
    const initialState = isDraftOrder ? 'DRAFT' : 'OPEN_INQUIRY';

    // 1. Create the base order ledger entry
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        client_id: userId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        shop_id: payload.shopId,
        state: initialState,
        total: 15.00, 
      })
      .select()
      .single();

    if (orderError) {
      throw new InternalServerErrorException(
        'Failed to create order ledger entry: ' + orderError.message,
      );
    }

    // 2. Upload the raw design asset to the 'assets' bucket
    await this.ensureAssetsBucket();
    const fileName = `${userId}-${order.id}-${Date.now()}-${file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('assets')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      throw new InternalServerErrorException(`Failed to upload asset: ${uploadError.message}`);
    }

    const { data: urlData } = supabase
      .storage
      .from('assets')
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;

    // 3. Link the design asset to the newly created order
    const { error: assetError } = await supabase.from('assets').insert({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      order_id: order.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      file_url: publicUrl,
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

  async ensureAssetsBucket() {
    const supabase = this.supabaseService.getAdminClient();
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      this.logger.error("Error listing buckets:", listError);
      throw new InternalServerErrorException(`Failed to list buckets: ${listError.message}`);
    }
    if (!buckets?.find(b => b.name === 'assets')) {
      const { error: createError } = await supabase.storage.createBucket('assets', { public: true });
      if (createError) throw new InternalServerErrorException(`Failed to create assets bucket: ${createError.message}`);
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