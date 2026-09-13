import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDFDocument } from 'pdf-lib';
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
    
    const { data: draftData, error: draftError } = await supabase
      .from('orders')
      .delete()
      .eq('state', 'OPEN_INQUIRY')
      .lt('created_at', expiryTime)
      .select('id');

    if (draftError) {
      this.logger.error('Failed to cleanup expired drafts: ' + draftError.message);
    } else if (draftData && draftData.length > 0) {
      this.logger.log(`Cleaned up ${draftData.length} expired drafts.`);
    }

    // Cleanup AWAITING_PAYMENT orders that have passed their 24-hour expiration window
    const now = new Date().toISOString();
    const { data: expiredOrders, error: expiredError } = await supabase
      .from('orders')
      .update({ state: 'EXPIRED' })
      .eq('state', 'AWAITING_PAYMENT')
      .lt('expires_at', now)
      .select('id');

    if (expiredError) {
      this.logger.error('Failed to expire rejected orders: ' + expiredError.message);
    } else if (expiredOrders && expiredOrders.length > 0) {
      this.logger.log(`Expired ${expiredOrders.length} rejected orders.`);
    }
  }

  async getUserOrders(userId: string, sortByDate: 'asc' | 'desc' = 'desc', status?: string, page: number = 1, limit: number = 10) {
    const supabase = this.supabaseService.getAdminClient();
    let query = supabase
      .from('orders')
      .select('*, shops(name)', { count: 'exact' })
      .eq('client_id', userId)
      .neq('state', 'DRAFT')
      .order('created_at', { ascending: sortByDate === 'asc' });

    if (status && status !== 'All') {
      query = query.eq('state', status);
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    query = query.range(from, to);

    const { data, error, count } = await query;

    if (error) {
      throw new InternalServerErrorException('Failed to fetch orders: ' + error.message);
    }

    const totalItems = count || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return {
      data,
      meta: {
        currentPage: page,
        totalPages,
        totalItems
      }
    };
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

  async getDrafts(userId: string, page: number = 1, limit: number = 10) {
    const supabase = this.supabaseService.getAdminClient();
    
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Ensure shop_id and assets(file_url) are included in the select query
    const { data, error, count } = await supabase
      .from('orders')
      .select('id, total, created_at, shop_id, shops(name), assets(file_url), paper_size, print_color_mode, page_count', { count: 'exact' })
      .eq('client_id', userId)
      .eq('state', 'DRAFT') 
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      throw new InternalServerErrorException('Failed to fetch drafts: ' + error.message);
    }

    const mappedData = data.map((order: any) => {
      let fileUrl = '';
      let fileName = 'Design File';
      
      if (order.assets && order.assets.length > 0 && order.assets[0].file_url) {
        fileUrl = order.assets[0].file_url;
        const urlParts = fileUrl.split('/');
        let rawName = decodeURIComponent(urlParts[urlParts.length - 1]);
        const match = rawName.match(/-\d{13}-(.+)$/);
        fileName = match ? match[1] : rawName;
      }

      return {
        id: order.id,
        shopId: order.shop_id, 
        shopName: order.shops?.name || 'Unknown Shop',
        fileName: fileName,
        fileUrl: fileUrl,      
        total: order.total,
        updatedAt: order.created_at,
        paperSize: order.paper_size,
        printColorMode: order.print_color_mode,
        pageCount: order.page_count
      };
    });
    
    const totalItems = count || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    
    return {
      data: mappedData,
      meta: {
        currentPage: page,
        totalPages,
        totalItems
      }
    };
  }

  async updateDraft(userId: string, draftId: string, payload: { shopId: string; paperSize: string; printColorMode: string; total: number; pageCount: number }) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', draftId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order || order.state !== 'DRAFT') {
      throw new BadRequestException('Draft not found or not in draft state.');
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({
        shop_id: payload.shopId,
        paper_size: payload.paperSize,
        print_color_mode: payload.printColorMode,
        total: payload.total,
        page_count: payload.pageCount
      })
      .eq('id', draftId);

    if (updateError) {
      throw new InternalServerErrorException('Failed to update draft: ' + updateError.message);
    }

    return { message: 'Draft updated successfully' };
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

    // Fetch shop pricing matrix
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('pricing_matrix')
      .eq('id', payload.shopId)
      .single();

    if (shopError || !shop) {
      throw new InternalServerErrorException('Failed to fetch shop details.');
    }

    const pricingMatrix = shop.pricing_matrix || {
      paper_sizes: { "SHORT": 2.00, "A4": 3.00, "LONG": 4.00 },
      color_mode_multipliers: { "BLACK_AND_WHITE": 0.00, "COLOR": 3.00 }
    };

    let pageCount = 1;
    if (file.mimetype === 'application/pdf') {
      try {
        const pdfDoc = await PDFDocument.load(file.buffer);
        pageCount = pdfDoc.getPageCount();
      } catch (e) {
        console.warn('Failed to parse PDF on backend, defaulting to 1 page:', e);
      }
    }

    const basePrice = pricingMatrix.paper_sizes[payload.paperSize] || 3.00;
    const colorAdditive = pricingMatrix.color_mode_multipliers[payload.printColorMode] || 0.00;
    const calculatedTotal = (basePrice + colorAdditive) * pageCount;

    // 1. Create the base order ledger entry
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        client_id: userId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        shop_id: payload.shopId,
        state: initialState,
        total: calculatedTotal,
        print_color_mode: payload.printColorMode,
        paper_size: payload.paperSize,
        page_count: pageCount
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
      file_type: file.mimetype.startsWith('image/') ? 'IMAGE' : 'PDF',
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

  async disputePayment(userId: string, orderId: string, reason: string) {
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

    // Can only dispute if previously rejected and awaiting payment
    if (order.state !== 'AWAITING_PAYMENT') {
      throw new BadRequestException('Order is not in a state that can be disputed.');
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({ 
        state: 'ESCALATED_DISPUTE',
        dispute_reason: reason,
        expires_at: null // Clear expiration timer during dispute
      })
      .eq('id', orderId);

    if (updateError) {
      throw new InternalServerErrorException('Failed to escalate dispute: ' + updateError.message);
    }

    return { message: 'Payment dispute escalated successfully.' };
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
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { error: updateError } = await supabase.from('orders')
        .update({ 
          state: 'AWAITING_PAYMENT',
          shop_rejection_reason: reason || null,
          expires_at: expiresAt
        })
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

  async updateOrderState(shopId: string, orderId: string, newState: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .eq('shop_id', shopId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found or access denied.');
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({ state: newState })
      .eq('id', orderId);

    if (updateError) {
      throw new InternalServerErrorException('Failed to update order state: ' + updateError.message);
    }

    return { message: 'Order state updated successfully', state: newState };
  }
}