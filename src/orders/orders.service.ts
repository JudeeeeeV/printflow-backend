import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import {
  assertFileSignature,
  IMAGE_MIME_TYPES,
  PRINTABLE_DOCUMENT_MIME_TYPES,
  secureObjectName,
} from '../common/upload-security';
import { PrintableDocumentService } from './printable-document.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly printableDocuments: PrintableDocumentService,
  ) {}

  private async requireVerifiedShop(shopId: string): Promise<void> {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select('id')
      .eq('id', shopId)
      .eq('verification_status', 'VERIFIED')
      .single();
    if (error || !data) {
      throw new ForbiddenException('A verified shop account is required');
    }
  }

  private calculatePrice(
    pricingMatrix: any,
    paperSize: string,
    printColorMode: string,
    pageCount: number,
  ): number {
    const basePrice = Number(pricingMatrix?.paper_sizes?.[paperSize]);
    const colorAdditive = Number(
      pricingMatrix?.color_mode_multipliers?.[printColorMode],
    );
    if (
      !Number.isFinite(basePrice) ||
      basePrice < 0 ||
      !Number.isFinite(colorAdditive) ||
      colorAdditive < 0 ||
      !Number.isInteger(pageCount) ||
      pageCount < 1
    ) {
      throw new BadRequestException('Invalid print options or shop pricing');
    }
    return Math.round((basePrice + colorAdditive) * pageCount * 100) / 100;
  }

  private async getAssetPageCount(orderId: string): Promise<number> {
    const supabase = this.supabaseService.getAdminClient();
    const { data: asset, error } = await supabase
      .from('assets')
      .select('file_url, file_type')
      .eq('order_id', orderId)
      .limit(1)
      .single();
    if (error || !asset) throw new BadRequestException('Draft asset not found');
    if (asset.file_type !== 'PDF') return 1;

    const path = this.supabaseService.storagePath(asset.file_url, 'assets');
    if (!path) throw new BadRequestException('Draft asset path is invalid');
    const { data: blob, error: downloadError } = await supabase.storage
      .from('assets')
      .download(path);
    if (downloadError || !blob) {
      throw new BadRequestException('Draft asset could not be validated');
    }
    try {
      const printable = await this.printableDocuments.normalize(
        {
          mimetype: 'application/pdf',
          buffer: Buffer.from(await blob.arrayBuffer()),
        } as Express.Multer.File,
        'A4',
      );
      return printable.pageCount;
    } catch {
      throw new BadRequestException('Draft PDF is invalid');
    }
  }

  private async signOrderStorageFields(order: any): Promise<any> {
    const signed = { ...order };
    if (Array.isArray(order.assets)) {
      signed.assets = await Promise.all(
        order.assets.map(async (asset: any) => ({
          ...asset,
          file_url: await this.supabaseService.createSignedStorageUrl(
            'assets',
            asset.file_url,
            300,
          ),
        })),
      );
    }
    if (Array.isArray(order.payment_receipts)) {
      signed.payment_receipts = await Promise.all(
        order.payment_receipts.map(async (receipt: any) => ({
          ...receipt,
          receipt_url: await this.supabaseService.createSignedStorageUrl(
            'receipts',
            receipt.receipt_url,
            300,
          ),
        })),
      );
    }
    if (order.shops?.gcash_qr_url) {
      signed.shops = {
        ...order.shops,
        gcash_qr_url: await this.supabaseService.createSignedStorageUrl(
          'gcash_qrs',
          order.shops.gcash_qr_url,
          300,
        ),
      };
    }
    return signed;
  }

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
      this.logger.error(
        'Failed to cleanup expired drafts: ' + draftError.message,
      );
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
      this.logger.error(
        'Failed to expire rejected orders: ' + expiredError.message,
      );
    } else if (expiredOrders && expiredOrders.length > 0) {
      this.logger.log(`Expired ${expiredOrders.length} rejected orders.`);
    }
  }

  async getUserOrders(
    userId: string,
    sortByDate: 'asc' | 'desc' = 'desc',
    status?: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    page = Number.isInteger(page) && page > 0 ? page : 1;
    limit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
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
      throw new InternalServerErrorException(
        'Failed to fetch orders: ' + error.message,
      );
    }

    const totalItems = count || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return {
      data: await Promise.all(
        (data || []).map((order) => this.signOrderStorageFields(order)),
      ),
      meta: {
        currentPage: page,
        totalPages,
        totalItems,
      },
    };
  }

  async getShopOrders(shopId: string) {
    const supabase = this.supabaseService.getAdminClient();
    await this.requireVerifiedShop(shopId);
    const { data, error } = await supabase
      .from('orders')
      .select('*, payment_receipts(*), assets(*)')
      .eq('shop_id', shopId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(
        'Failed to fetch shop orders: ' + error.message,
      );
    }
    return Promise.all(
      (data || []).map((order) => this.signOrderStorageFields(order)),
    );
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
    return this.signOrderStorageFields(data);
  }

  async getDrafts(userId: string, page: number = 1, limit: number = 10) {
    const supabase = this.supabaseService.getAdminClient();
    page = Number.isInteger(page) && page > 0 ? page : 1;
    limit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Ensure shop_id and assets(file_url) are included in the select query
    const { data, error, count } = await supabase
      .from('orders')
      .select(
        'id, total, created_at, shop_id, shops(name), assets(file_url), paper_size, print_color_mode, page_count',
        { count: 'exact' },
      )
      .eq('client_id', userId)
      .eq('state', 'DRAFT')
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) {
      throw new InternalServerErrorException(
        'Failed to fetch drafts: ' + error.message,
      );
    }

    const mappedData = await Promise.all(
      (data || []).map(async (order: any) => {
        let fileUrl = '';
        let fileName = 'Design File';

        if (
          order.assets &&
          order.assets.length > 0 &&
          order.assets[0].file_url
        ) {
          fileUrl =
            (await this.supabaseService.createSignedStorageUrl(
              'assets',
              order.assets[0].file_url,
              300,
            )) || '';
          const urlParts = fileUrl.split('/');
          const rawName = decodeURIComponent(urlParts[urlParts.length - 1]);
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
          pageCount: order.page_count,
        };
      }),
    );

    const totalItems = count || 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));

    return {
      data: mappedData,
      meta: {
        currentPage: page,
        totalPages,
        totalItems,
      },
    };
  }

  async updateDraft(userId: string, draftId: string, payload: UpdateDraftDto) {
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

    await this.requireVerifiedShop(payload.shopId);
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('pricing_matrix')
      .eq('id', payload.shopId)
      .eq('verification_status', 'VERIFIED')
      .single();
    if (shopError || !shop)
      throw new BadRequestException('Shop is unavailable');

    const pageCount = await this.getAssetPageCount(draftId);
    const total = this.calculatePrice(
      shop.pricing_matrix,
      payload.paperSize,
      payload.printColorMode,
      pageCount,
    );

    const { data: updatedDraft, error: updateError } = await supabase
      .from('orders')
      .update({
        shop_id: payload.shopId,
        paper_size: payload.paperSize,
        print_color_mode: payload.printColorMode,
        total,
        page_count: pageCount,
      })
      .eq('id', draftId)
      .eq('client_id', userId)
      .eq('state', 'DRAFT')
      .select('id')
      .maybeSingle();

    if (updateError || !updatedDraft) {
      throw new InternalServerErrorException(
        'Failed to update draft because it changed concurrently',
      );
    }

    return { message: 'Draft updated successfully' };
  }

  async submitDraft(userId: string, draftId: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state, shop_id, paper_size, print_color_mode')
      .eq('id', draftId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Draft not found');
    }

    if (order.state !== 'DRAFT') {
      throw new BadRequestException('Order is not a draft.');
    }

    await this.requireVerifiedShop(order.shop_id);
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('pricing_matrix')
      .eq('id', order.shop_id)
      .single();
    if (shopError || !shop)
      throw new BadRequestException('Shop is unavailable');
    const pageCount = await this.getAssetPageCount(draftId);
    const total = this.calculatePrice(
      shop.pricing_matrix,
      order.paper_size,
      order.print_color_mode,
      pageCount,
    );

    const { data: submittedDraft, error: updateError } = await supabase
      .from('orders')
      .update({
        state: 'OPEN_INQUIRY',
        total,
        page_count: pageCount,
        created_at: new Date().toISOString(), // This resets the 15-minute clock!
      })
      .eq('id', draftId)
      .eq('client_id', userId)
      .eq('state', 'DRAFT')
      .select('id')
      .maybeSingle();

    if (updateError || !submittedDraft) {
      throw new InternalServerErrorException(
        'Failed to submit draft because it changed concurrently',
      );
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
      throw new InternalServerErrorException(
        'Failed to delete draft: ' + deleteError.message,
      );
    }

    return { message: 'Draft deleted successfully' };
  }

  async createOrder(
    userId: string,
    payload: CreateOrderDto,
    file: Express.Multer.File,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    assertFileSignature(file, PRINTABLE_DOCUMENT_MIME_TYPES);

    // Evaluate the string sent by FormData
    const isDraftOrder = payload.isDraft === 'true';
    const initialState = isDraftOrder ? 'DRAFT' : 'OPEN_INQUIRY';

    // Fetch shop pricing matrix
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('pricing_matrix')
      .eq('id', payload.shopId)
      .eq('verification_status', 'VERIFIED')
      .single();

    if (shopError || !shop) {
      throw new InternalServerErrorException('Failed to fetch shop details.');
    }

    const pricingMatrix = shop.pricing_matrix;

    const printable = await this.printableDocuments.normalize(
      file,
      payload.paperSize,
    );
    const pageCount = printable.pageCount;

    const calculatedTotal = this.calculatePrice(
      pricingMatrix,
      payload.paperSize,
      payload.printColorMode,
      pageCount,
    );

    // 1. Create the base order ledger entry
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        client_id: userId,

        shop_id: payload.shopId,
        state: initialState,
        total: calculatedTotal,
        print_color_mode: payload.printColorMode,
        paper_size: payload.paperSize,
        page_count: pageCount,
      })
      .select()
      .single();

    if (orderError) {
      throw new InternalServerErrorException(
        'Failed to create order ledger entry: ' + orderError.message,
      );
    }

    // 2. Store a normalized PDF so every printer agent receives one format.
    await this.ensureAssetsBucket();
    const fileName = secureObjectName(
      `${userId}/${order.id}`,
      'application/pdf',
    );
    const { error: uploadError } = await supabase.storage
      .from('assets')
      .upload(fileName, printable.buffer, {
        contentType: 'application/pdf',
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload asset: ${uploadError.message}`,
      );
    }

    // 3. Link the design asset to the newly created order
    const { error: assetError } = await supabase.from('assets').insert({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      order_id: order.id,

      file_url: fileName,
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
    await this.supabaseService.ensurePrivateBucket('receipts');
  }

  async ensureAssetsBucket() {
    await this.supabaseService.ensurePrivateBucket('assets');
  }

  async submitPaymentReceipt(
    userId: string,
    orderId: string,
    file: Express.Multer.File,
    referenceNumber?: string,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    assertFileSignature(file, IMAGE_MIME_TYPES);
    await this.ensureReceiptsBucket();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state, shop_id')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException(
        'Order not found or you do not have permission to access it.',
      );
    }

    if (
      order.state !== 'PROOF_APPROVED' &&
      order.state !== 'AWAITING_PAYMENT' &&
      order.state !== 'OPEN_INQUIRY'
    ) {
      throw new BadRequestException(
        `Cannot upload receipt for an order in ${order.state} state.`,
      );
    }

    // Assume bucket exists. User should create it in Supabase Dashboard.

    const fileName = secureObjectName(`${userId}/${orderId}`, file.mimetype);
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload receipt image: ${uploadError.message}`,
      );
    }

    const { error: receiptError } = await supabase
      .from('payment_receipts')
      .insert({
        order_id: orderId,
        uploaded_by: userId,
        receipt_url: fileName,
        reference_number: referenceNumber || null,
        verified: false,
      });

    if (receiptError) {
      throw new InternalServerErrorException(
        'Failed to upload receipt record: ' + receiptError.message,
      );
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('orders')
      .update({ state: 'AWAITING_PAYMENT_VERIFICATION' })
      .eq('id', orderId)
      .eq('client_id', userId)
      .in('state', ['PROOF_APPROVED', 'AWAITING_PAYMENT', 'OPEN_INQUIRY'])
      .select('id')
      .maybeSingle();

    if (updateError || !updatedOrder) {
      throw new InternalServerErrorException(
        'Receipt uploaded, but failed to update order state.',
      );
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
      throw new BadRequestException(
        'Order is not in a state that can be disputed.',
      );
    }

    const { data: disputedOrder, error: updateError } = await supabase
      .from('orders')
      .update({
        state: 'ESCALATED_DISPUTE',
        dispute_reason: reason,
        expires_at: null, // Clear expiration timer during dispute
      })
      .eq('id', orderId)
      .eq('client_id', userId)
      .eq('state', 'AWAITING_PAYMENT')
      .select('id')
      .maybeSingle();

    if (updateError || !disputedOrder) {
      throw new InternalServerErrorException(
        'Failed to escalate dispute because the order changed concurrently',
      );
    }

    return { message: 'Payment dispute escalated successfully.' };
  }

  async verifyPayment(
    clerkId: string,
    orderId: string,
    action: 'APPROVE' | 'REJECT',
    reason?: string,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    await this.requireVerifiedShop(clerkId);

    // In a real app we might verify if clerkId belongs to the shop that owns the order
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state, shop_id')
      .eq('id', orderId)
      .eq('shop_id', clerkId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found.');
    }

    if (order.state !== 'AWAITING_PAYMENT_VERIFICATION') {
      throw new BadRequestException(
        'Order is not awaiting payment verification.',
      );
    }

    if (action === 'APPROVE') {
      await supabase
        .from('payment_receipts')
        .update({ verified: true })
        .eq('order_id', orderId);

      const { data: approvedOrder, error: updateError } = await supabase
        .from('orders')
        .update({ state: 'IN_PRODUCTION' })
        .eq('id', orderId)
        .eq('shop_id', clerkId)
        .eq('state', 'AWAITING_PAYMENT_VERIFICATION')
        .select('id')
        .maybeSingle();

      if (updateError || !approvedOrder)
        throw new InternalServerErrorException('Failed to update order state.');

      // Clear notifications
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('order_id', orderId);

      return { message: 'Payment approved. Order is now in production.' };
    } else {
      // REJECT
      const expiresAt = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data: rejectedOrder, error: updateError } = await supabase
        .from('orders')
        .update({
          state: 'AWAITING_PAYMENT',
          shop_rejection_reason: reason || null,
          expires_at: expiresAt,
        })
        .eq('id', orderId)
        .eq('shop_id', clerkId)
        .eq('state', 'AWAITING_PAYMENT_VERIFICATION')
        .select('id')
        .maybeSingle();

      if (updateError || !rejectedOrder)
        throw new InternalServerErrorException('Failed to update order state.');

      // Clear notifications
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('order_id', orderId);

      return {
        message: 'Payment rejected. Client has been notified to re-upload.',
      };
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

    const cancellableStates = ['DRAFT', 'OPEN_INQUIRY', 'AWAITING_PAYMENT'];
    if (!cancellableStates.includes(order.state)) {
      throw new BadRequestException('This order can no longer be cancelled');
    }

    const { data: deletedOrder, error: deleteError } = await supabase
      .from('orders')
      .delete()
      .eq('id', orderId)
      .eq('client_id', userId)
      .in('state', cancellableStates)
      .select('id')
      .maybeSingle();

    if (deleteError || !deletedOrder) {
      throw new InternalServerErrorException(
        'Failed to cancel order because it changed concurrently',
      );
    }

    return { message: 'Order cancelled successfully' };
  }

  async updateOrderState(
    shopId: string,
    orderId: string,
    newState: 'READY_FOR_PICKUP' | 'COMPLETED',
  ) {
    const supabase = this.supabaseService.getAdminClient();
    await this.requireVerifiedShop(shopId);

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .eq('shop_id', shopId)
      .single();

    if (fetchError || !order) {
      throw new NotFoundException('Order not found or access denied.');
    }

    const transitions: Record<string, string[]> = {
      IN_PRODUCTION: ['READY_FOR_PICKUP'],
      PRINTED: ['READY_FOR_PICKUP'],
      READY_FOR_PICKUP: ['COMPLETED'],
    };
    if (!transitions[order.state]?.includes(newState)) {
      throw new BadRequestException(
        `Cannot transition an order from ${order.state} to ${newState}`,
      );
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from('orders')
      .update({ state: newState })
      .eq('id', orderId)
      .eq('shop_id', shopId)
      .eq('state', order.state)
      .select('id')
      .maybeSingle();

    if (updateError || !updatedOrder) {
      throw new InternalServerErrorException(
        'Failed to update order state because it changed concurrently',
      );
    }

    return { message: 'Order state updated successfully', state: newState };
  }
}
