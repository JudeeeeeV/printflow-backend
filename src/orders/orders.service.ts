import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
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
import {
  PrintableDocumentService,
  type PrintOrientation,
} from './printable-document.service';
import { validateStoredOrderDocument } from './stored-order-document';
import { isShopOpenNow } from '../shops/shop-availability';
import { applyOrderDecision, type PaymentOrder } from './payment-workflow';
import {
  ATTEMPT_COLUMNS,
  fulfillmentError,
  fulfillmentStage,
  OUTPUT_CHECKS,
  presentAttempt,
  type PrintAttemptRow,
  type RpcResult,
} from './print-fulfillment';

/** States whose print attempts matter to operators and students. */
const FULFILLMENT_STATES = new Set([
  'IN_PRODUCTION',
  'PRINTED',
  'READY_FOR_PICKUP',
  'COMPLETED',
]);

const SHOP_VISIBLE_ORDER_STATES = new Set([
  'OPEN_INQUIRY',
  'PROOF_APPROVED',
  'AWAITING_PAYMENT',
  'AWAITING_PAYMENT_VERIFICATION',
  'ESCALATED_DISPUTE',
  'IN_PRODUCTION',
  'PRINTED',
  'READY_FOR_PICKUP',
  'COMPLETED',
  'EXPIRED',
  'CANCELLED',
  'REJECTED',
]);

const isMissingOriginalFilenameColumn = (
  error: { code?: string; message?: string } | null,
): boolean =>
  Boolean(
    error &&
    (error.code === '42703' || error.code === 'PGRST204') &&
    error.message?.includes('original_filename'),
  );

const isMissingGcashNumberColumn = (
  error: { code?: string; message?: string } | null,
): boolean =>
  Boolean(
    error &&
    (error.code === '42703' || error.code === 'PGRST204') &&
    error.message?.includes('gcash_number'),
  );

interface DraftRow {
  id: string;
  shop_id: string;
  payment_method?: 'GCASH' | 'CASH_ON_PICKUP';
  shops?: { name: string } | null;
  assets?: Array<{ file_url: string; original_filename?: string | null }>;
  total: number;
  created_at: string;
  paper_size: string;
  print_color_mode: string;
  page_count: number;
  order_name?: string | null;
  orientation?: PrintOrientation | null;
  copies?: number | null;
}

interface SubmittedDraftRow {
  state: string;
  shop_id: string;
  paper_size: string;
  print_color_mode: string;
  copies?: number | null;
  draft_version: number;
}

interface ShopPricingRow {
  pricing_matrix: {
    paper_sizes?: Record<string, number>;
    color_mode_multipliers?: Record<string, number>;
  } | null;
}

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
    copies = 1,
  ): number {
    // Only real numbers or non-blank numeric strings count as prices; Number()
    // alone would turn null, '', false or [] into 0 and make the order free.
    const toPrice = (value: unknown): number =>
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN;
    const basePrice = toPrice(pricingMatrix?.paper_sizes?.[paperSize]);
    const colorAdditive = toPrice(
      pricingMatrix?.color_mode_multipliers?.[printColorMode],
    );
    if (
      !Number.isFinite(basePrice) ||
      basePrice < 0 ||
      !Number.isFinite(colorAdditive) ||
      colorAdditive < 0 ||
      !Number.isInteger(pageCount) ||
      pageCount < 1 ||
      !Number.isInteger(copies) ||
      copies < 1 ||
      copies > 99
    ) {
      throw new BadRequestException('Invalid print options or shop pricing');
    }
    const total =
      Math.round((basePrice + colorAdditive) * pageCount * copies * 100) / 100;
    if (!Number.isFinite(total)) {
      throw new BadRequestException('Invalid print options or shop pricing');
    }
    return total;
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
      // The stored document was normalized during upload. Validate and count it
      // without rebuilding every page just to inspect an existing order.
      return await this.printableDocuments.getPdfPageCount(
        Buffer.from(await blob.arrayBuffer()),
      );
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
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('orders')
      .select('id')
      .eq('state', 'OPEN_INQUIRY')
      .eq('payment_method', 'GCASH')
      .in('payment_status', ['UNPAID', 'REJECTED'])
      .lt('expires_at', new Date().toISOString());
    if (error) {
      this.logger.error('Failed to inspect payment deadlines.');
      return;
    }
    for (const order of (data || []) as Array<{ id: string }>) {
      try {
        await applyOrderDecision(
          this.supabaseService,
          order.id,
          null,
          'SYSTEM',
          'EXPIRE',
        );
      } catch {
        this.logger.error('Failed to reconcile a payment deadline.');
      }
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
      const legacyPaymentFilters: Record<string, string> = {
        AWAITING_PAYMENT: 'REJECTED',
        AWAITING_PAYMENT_VERIFICATION: 'PENDING_VERIFICATION',
        ESCALATED_DISPUTE: 'DISPUTED',
      };
      const paymentFilter =
        legacyPaymentFilters[status] ||
        ([
          'UNPAID',
          'PENDING_VERIFICATION',
          'VERIFIED',
          'DISPUTED',
          'DUE_AT_PICKUP',
          'COLLECTED',
          'REFUND_DUE',
          'REFUNDED',
          'REVIEW_REQUIRED',
        ].includes(status)
          ? status
          : null);
      query = query.eq(
        paymentFilter ? 'payment_status' : 'state',
        paymentFilter || status,
      );
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
    const staged = await this.withFulfillmentStages(
      (data || []) as Array<{ id: string; state: string }>,
    );

    return {
      data: await Promise.all(
        staged.map((order) => this.signOrderStorageFields(order)),
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
      // Only use a universally deployed enum value in the database predicate.
      // Other workflow states may not exist in older deployments' enum yet.
      .neq('state', 'DRAFT')
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(
        'Failed to fetch shop orders: ' + error.message,
      );
    }
    // Apply the allowlist before profile lookups, signing, or returning assets.
    const orders = (data || []).filter((order) =>
      SHOP_VISIBLE_ORDER_STATES.has(order.state),
    );
    const clientIds = [...new Set(orders.map((order) => order.client_id))];
    if (!clientIds.length) return [];
    const [{ data: clients, error: clientsError }, assets, receipts, attempts] =
      await Promise.all([
        supabase
          .from('users')
          .select('id, first_name, last_name')
          .in('id', clientIds),
        this.supabaseService.createSignedStorageUrls(
          'assets',
          orders.flatMap((order) =>
            (order.assets || []).map(
              (asset: { file_url: string }) => asset.file_url,
            ),
          ),
        ),
        this.supabaseService.createSignedStorageUrls(
          'receipts',
          orders.flatMap((order) =>
            (order.payment_receipts || []).map(
              (receipt: { receipt_url: string }) => receipt.receipt_url,
            ),
          ),
        ),
        this.latestAttempts(
          orders
            .filter((order) => FULFILLMENT_STATES.has(order.state))
            .map((order) => order.id),
          shopId,
        ),
      ]);
    if (clientsError) {
      throw new InternalServerErrorException('Failed to fetch client names.');
    }
    const names = new Map(
      (clients || []).map((client) => [
        client.id,
        [client.first_name, client.last_name].filter(Boolean).join(' ').trim(),
      ]),
    );
    const now = Date.now();
    return orders.map((order) => ({
      ...order,
      // Persisted progress: reopening the dashboard does not depend on sockets.
      current_attempt: attempts.latest.has(order.id)
        ? presentAttempt(attempts.latest.get(order.id)!, now)
        : null,
      attempt_count: attempts.counts.get(order.id) || 0,
      client_name: names.get(order.client_id) || null,
      assets: (order.assets || []).map((asset: { file_url: string }) => ({
        ...asset,
        file_url: assets.get(asset.file_url) || null,
      })),
      payment_receipts: (order.payment_receipts || []).map(
        (receipt: { receipt_url: string }) => ({
          ...receipt,
          receipt_url: receipts.get(receipt.receipt_url) || null,
        }),
      ),
    }));
  }

  async getOrder(userId: string, orderId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const fetchOrder = (includeGcashNumber: boolean) =>
      supabase
        .from('orders')
        .select(
          includeGcashNumber
            ? '*, shops(name, gcash_number, gcash_qr_url), payment_receipts(*)'
            : '*, shops(name, gcash_qr_url), payment_receipts(*)',
        )
        .eq('id', orderId)
        .eq('client_id', userId)
        .single();

    let { data, error } = await fetchOrder(true);
    if (isMissingGcashNumberColumn(error)) {
      ({ data, error } = await fetchOrder(false));
    }

    if (error || !data) {
      throw new NotFoundException('Order not found');
    }
    const [staged] = await this.withFulfillmentStages([
      data as unknown as { id: string; state: string },
    ]);
    return this.signOrderStorageFields(staged);
  }

  async getDrafts(userId: string, page: number = 1, limit: number = 10) {
    const supabase = this.supabaseService.getAdminClient();
    page = Number.isInteger(page) && page > 0 ? page : 1;
    limit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const fetchDraftRows = (includeOriginalFilename: boolean) => {
      const assetColumns = includeOriginalFilename
        ? 'assets(file_url, original_filename)'
        : 'assets(file_url)';

      return supabase
        .from('orders')
        .select(
          `id, total, created_at, shop_id, shops(name), ${assetColumns}, paper_size, print_color_mode, page_count, order_name, orientation, copies, payment_method`,
          { count: 'exact' },
        )
        .eq('client_id', userId)
        .eq('state', 'DRAFT')
        .order('created_at', { ascending: false })
        .range(from, to);
    };

    let { data, error, count } = await fetchDraftRows(true);
    if (isMissingOriginalFilenameColumn(error)) {
      ({ data, error, count } = await fetchDraftRows(false));
    }

    if (error) {
      throw new InternalServerErrorException(
        'Failed to fetch drafts: ' + error.message,
      );
    }

    const mappedData = await Promise.all(
      ((data || []) as unknown as DraftRow[]).map(async (order) => {
        let fileUrl = '';
        let fileName = 'Design File';
        let storedPath = '';
        let originalFileName = order.assets?.[0]?.original_filename || null;

        if (
          order.assets &&
          order.assets.length > 0 &&
          order.assets[0].file_url
        ) {
          storedPath = this.supabaseService.storagePath(
            order.assets[0].file_url,
            'assets',
          );
          const rawName = decodeURIComponent(storedPath.split('/').pop() || '');
          const match = rawName.match(/-\d{13}-(.+)$/);
          fileName = (match ? match[1] : rawName) || fileName;
          fileUrl =
            (await this.supabaseService.createSignedStorageUrl(
              'assets',
              order.assets[0].file_url,
              300,
            )) || '';
        }

        if (!originalFileName && storedPath) {
          try {
            const { data: assetInfo } = await supabase.storage
              .from('assets')
              .info(storedPath);
            const assetMetadata = assetInfo as {
              metadata?: Record<string, unknown> | null;
              userMetadata?: Record<string, unknown> | null;
            } | null;
            const storedName =
              assetMetadata?.userMetadata?.originalFileName ??
              assetMetadata?.metadata?.originalFileName;
            if (typeof storedName === 'string' && storedName.trim()) {
              originalFileName = storedName.trim();
            }
          } catch {
            // Metadata is optional; keep legacy drafts available.
          }
        }

        return {
          id: order.id,
          shopId: order.shop_id,
          shopName: order.shops?.name || 'Unknown Shop',
          fileName: fileName,
          originalFileName,
          fileUrl: fileUrl,
          total: order.total,
          updatedAt: order.created_at,
          paperSize: order.paper_size,
          printColorMode: order.print_color_mode,
          pageCount: order.page_count,
          orderName: order.order_name,
          orientation: order.orientation,
          copies: order.copies,
          paymentMethod: order.payment_method || 'GCASH',
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
      .select('state, draft_version')
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
      payload.copies,
    );

    const { data: updatedDraft, error: updateError } = await supabase
      .from('orders')
      .update({
        shop_id: payload.shopId,
        paper_size: payload.paperSize,
        print_color_mode: payload.printColorMode,
        total,
        page_count: pageCount,
        ...(payload.paymentMethod
          ? { payment_method: payload.paymentMethod }
          : {}),
        order_name: payload.orderName.trim(),
        orientation: payload.orientation,
        copies: payload.copies,
      })
      .eq('id', draftId)
      .eq('client_id', userId)
      .eq('state', 'DRAFT')
      .eq('draft_version', order.draft_version)
      .select('*')
      .maybeSingle<PaymentOrder>();

    if (updateError) {
      throw new InternalServerErrorException('Failed to update draft.');
    }
    if (!updatedDraft) {
      throw new ConflictException(
        'This draft changed while you were editing. Reload it and try again.',
      );
    }

    return { message: 'Draft updated successfully', order: updatedDraft };
  }

  async submitDraft(
    userId: string,
    draftId: string,
    paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP',
  ) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select(
        'state, shop_id, paper_size, print_color_mode, copies, draft_version',
      )
      .eq('id', draftId)
      .eq('client_id', userId)
      .single<SubmittedDraftRow>();

    if (fetchError || !order) {
      throw new NotFoundException('Draft not found');
    }

    if (order.state !== 'DRAFT') {
      throw new BadRequestException('Order is not a draft.');
    }

    await this.requireVerifiedShop(order.shop_id);
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select(
        'pricing_matrix, availability_override, opens_at, closes_at, timezone',
      )
      .eq('id', order.shop_id)
      .single();
    if (shopError || !shop)
      throw new BadRequestException('Shop is unavailable');
    if (!isShopOpenNow(shop))
      throw new BadRequestException('Shop is currently closed');
    const pageCount = await this.getAssetPageCount(draftId);
    const total = this.calculatePrice(
      shop.pricing_matrix,
      order.paper_size,
      order.print_color_mode,
      pageCount,
      order.copies ?? 1,
    );

    const { data: submittedDraft, error: updateError } = await supabase
      .from('orders')
      .update({
        ...(paymentMethod ? { payment_method: paymentMethod } : {}),
        state: 'OPEN_INQUIRY',
        total,
        page_count: pageCount,
        created_at: new Date().toISOString(), // This resets the 15-minute clock!
      })
      .eq('id', draftId)
      .eq('client_id', userId)
      .eq('state', 'DRAFT')
      .eq('draft_version', order.draft_version)
      .select('*')
      .maybeSingle<PaymentOrder>();

    if (updateError) {
      throw new InternalServerErrorException('Failed to submit draft.');
    }
    if (!submittedDraft) {
      throw new ConflictException(
        'This draft changed while you were submitting. Review it and try again.',
      );
    }

    return {
      message: 'Draft submitted successfully',
      orderId: draftId,
      state: submittedDraft.state,
      order: submittedDraft,
    };
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
      .select(
        'pricing_matrix, availability_override, opens_at, closes_at, timezone',
      )
      .eq('id', payload.shopId)
      .eq('verification_status', 'VERIFIED')
      .single();

    if (shopError || !shop) {
      throw new InternalServerErrorException('Failed to fetch shop details.');
    }
    if (!isDraftOrder && !isShopOpenNow(shop)) {
      throw new BadRequestException('This shop is currently closed.');
    }

    const pricingMatrix = (shop as unknown as ShopPricingRow).pricing_matrix;

    const printable = await this.printableDocuments.normalize(
      file,
      payload.paperSize,
      payload.orientation,
    );
    const pageCount = printable.pageCount;

    const calculatedTotal = this.calculatePrice(
      pricingMatrix,
      payload.paperSize,
      payload.printColorMode,
      pageCount,
      payload.copies,
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
        ...(payload.paymentMethod
          ? { payment_method: payload.paymentMethod }
          : {}),
        order_name: payload.orderName.trim(),
        orientation: payload.orientation,
        copies: payload.copies,
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
    const originalFileName =
      file.originalname.split(/[\\/]/).pop()?.replaceAll('\0', '').trim() ||
      null;
    const fileName = secureObjectName(
      `${userId}/${order.id}`,
      'application/pdf',
    );
    const { error: uploadError } = await supabase.storage
      .from('assets')
      .upload(fileName, printable.buffer, {
        contentType: 'application/pdf',
        metadata: originalFileName ? { originalFileName } : undefined,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload asset: ${uploadError.message}`,
      );
    }

    // 3. Link the design asset to the newly created order
    const assetBase = {
      order_id: (order as { id: string }).id,
      file_url: fileName,
      dpi: 300, // Baseline required by application logic
      file_type: 'PDF',
    };
    let { error: assetError } = await supabase.from('assets').insert({
      ...assetBase,
      original_filename: originalFileName,
    });
    if (isMissingOriginalFilenameColumn(assetError)) {
      ({ error: assetError } = await supabase.from('assets').insert(assetBase));
    }

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
      order: order as PaymentOrder,
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
    if (
      typeof referenceNumber !== 'string' ||
      !referenceNumber.trim() ||
      referenceNumber.trim().length > 120
    ) {
      throw new BadRequestException(
        'A payment reference of at most 120 characters is required.',
      );
    }
    assertFileSignature(file, IMAGE_MIME_TYPES);
    const supabase = this.supabaseService.getAdminClient();
    const { data: owner, error } = await supabase
      .from('orders')
      .select('id, payment_method, payment_status, state, expires_at')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();
    if (error || !owner) throw new NotFoundException('Order not found.');
    // Reject obviously ineligible uploads before writing an unreferenced object.
    // The locked decision RPC remains authoritative when the order changes concurrently.
    if (owner.payment_method !== 'GCASH' ||
      ['DRAFT', 'CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED'].includes(owner.state) ||
      !['UNPAID', 'REJECTED', 'REVIEW_REQUIRED'].includes(owner.payment_status) ||
      (owner.expires_at && new Date(owner.expires_at).getTime() <= Date.now())) {
      throw new ConflictException('Receipt submission is not available for this order. Refresh its status.');
    }
    await this.ensureReceiptsBucket();
    const fileName = secureObjectName(`${userId}/${orderId}`, file.mimetype);
    const { error: uploadError } = await supabase.storage
      .from('receipts')
      .upload(fileName, file.buffer, { contentType: file.mimetype });
    if (uploadError)
      throw new InternalServerErrorException(
        'The receipt image could not be stored.',
      );
    let order: PaymentOrder;
    try {
      order = await applyOrderDecision(
        this.supabaseService, orderId, userId, 'STUDENT', 'UPLOAD_RECEIPT',
        { receiptPath: fileName, reference: referenceNumber.trim() },
      );
    } catch (decisionError) {
      // Only definite rejections rolled back. A timeout may already have committed.
      if (decisionError instanceof BadRequestException || decisionError instanceof ConflictException ||
        decisionError instanceof ForbiddenException || decisionError instanceof NotFoundException) {
        try {
          const { error: cleanupError } = await supabase.storage.from('receipts').remove([fileName]);
          if (cleanupError) this.logger.warn('Could not remove a rejected receipt upload.');
        } catch {
          this.logger.warn('Could not remove a rejected receipt upload.');
        }
      }
      throw decisionError;
    }
    return {
      message: 'Receipt saved. Awaiting payment verification.',
      state: order.state,
      order,
    };
  }

  async disputePayment(userId: string, orderId: string, reason: string) {
    const order = await applyOrderDecision(
      this.supabaseService,
      orderId,
      userId,
      'STUDENT',
      'DISPUTE',
      { reason },
    );
    return { message: 'Payment dispute escalated.', state: order.state, order };
  }

  async verifyPayment(
    clerkId: string,
    orderId: string,
    action: 'APPROVE' | 'REJECT',
    reason?: string,
    receiptId?: string,
    confirmed?: boolean,
  ) {
    if (action === 'APPROVE') {
      await this.requireVerifiedShop(clerkId);
      const { data: owned, error } = await this.supabaseService
        .getAdminClient()
        .from('orders')
        .select('id, state')
        .eq('id', orderId)
        .eq('shop_id', clerkId)
        .single<{ id: string; state: string }>();
      if (error || !owned) throw new NotFoundException('Order not found.');
      // Approval also authorizes production. Inspect the owned printable PDF
      // first, while closed-order payment reviews can still create refunds.
      if (
        !['CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED'].includes(owned.state)
      )
        await validateStoredOrderDocument(this.supabaseService, this.printableDocuments, orderId);
    }
    const order = await applyOrderDecision(
      this.supabaseService,
      orderId,
      clerkId,
      'SHOP',
      action === 'APPROVE' ? 'VERIFY' : 'REJECT_RECEIPT',
      { reason, receiptId, confirmed },
    );
    return {
      message:
        action === 'APPROVE'
          ? 'Payment verified.'
          : 'Receipt rejected; replacement requested.',
      state: order.state,
      order,
    };
  }

  async decideOrder(
    shopId: string,
    orderId: string,
    action: string,
    data: Record<string, unknown>,
  ) {
    await this.requireVerifiedShop(shopId);
    // Scope the file read before downloading any student's private document.
    const { data: owned, error } = await this.supabaseService
      .getAdminClient()
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .eq('shop_id', shopId)
      .single();
    if (error || !owned) throw new NotFoundException('Order not found.');
    if (action === 'ACCEPT') await validateStoredOrderDocument(this.supabaseService, this.printableDocuments, orderId);
    const order = await applyOrderDecision(
      this.supabaseService,
      orderId,
      shopId,
      'SHOP',
      action,
      data,
    );
    return { message: 'Order decision saved.', state: order.state, order };
  }

  async cancelOrder(userId: string, orderId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .eq('client_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Order not found.');
    if (data.state === 'DRAFT') return this.deleteDraft(userId, orderId);
    const order = await applyOrderDecision(
      this.supabaseService,
      orderId,
      userId,
      'STUDENT',
      'CANCEL',
    );
    return {
      message:
        'Order cancelled. Any verified payment requires a manual refund.',
      state: order.state,
      order,
    };
  }

  /**
   * Operator-controlled fulfillment. READY_FOR_PICKUP records an inspected
   * output for the current attempt; COMPLETED records handover after output
   * confirmation and payment. Printer callbacks never reach this path.
   */
  async updateOrderState(
    shopId: string,
    orderId: string,
    newState: 'READY_FOR_PICKUP' | 'COMPLETED',
    decision: {
      expectedAttemptId?: string | null;
      confirmed?: boolean;
      checks?: Record<string, unknown>;
      reconciliationReason?: string;
    } = {},
  ) {
    await this.requireVerifiedShop(shopId);
    if (decision.confirmed !== true)
      throw new BadRequestException(
        'Explicit operator confirmation is required.',
      );
    const supabase = this.supabaseService.getAdminClient();
    const response: { data: unknown; error: unknown } =
      newState === 'READY_FOR_PICKUP'
        ? await supabase.rpc('print_confirm_output', {
            p_order_id: orderId,
            p_shop_id: shopId,
            p_expected_attempt_id: decision.expectedAttemptId ?? null,
            p_actor_id: shopId,
            p_reason: decision.reconciliationReason?.trim() || null,
            p_checks: Object.fromEntries(
              OUTPUT_CHECKS.map((name) => [
                name,
                decision.checks?.[name] === true,
              ]),
            ),
          })
        : await supabase.rpc('print_record_handover', {
            p_order_id: orderId,
            p_shop_id: shopId,
            p_expected_attempt_id: decision.expectedAttemptId ?? null,
            p_actor_id: shopId,
          });
    if (response.error)
      throw new InternalServerErrorException(
        'The fulfillment decision could not be recorded. Try again.',
      );
    const result = response.data as RpcResult | null;
    if (!result?.ok) throw fulfillmentError(result?.code);
    return {
      message:
        newState === 'READY_FOR_PICKUP'
          ? 'Output confirmed. The order is ready for pickup.'
          : 'Handover recorded. The order is completed.',
      state: newState,
      duplicate: result.result === 'DUPLICATE',
    };
  }

  /** Latest attempt per order (open or most recent), or an empty map. */
  private async latestAttempts(orderIds: string[], shopId?: string) {
    const latest = new Map<string, PrintAttemptRow>();
    const counts = new Map<string, number>();
    if (orderIds.length === 0) return { latest, counts };
    let query = this.supabaseService
      .getAdminClient()
      .from('print_jobs')
      .select(ATTEMPT_COLUMNS)
      .in('order_id', orderIds);
    if (shopId) query = query.eq('shop_id', shopId);
    const { data, error } = await query.order('attempt_number', {
      ascending: false,
    });
    if (error) {
      // Keep queues readable during a staged rollout; progress reads resume
      // once the attempt migration is applied.
      this.logger.warn(`Failed to load print attempts: ${error.message}`);
      return { latest, counts };
    }
    for (const attempt of (data || []) as unknown as PrintAttemptRow[]) {
      counts.set(attempt.order_id, (counts.get(attempt.order_id) || 0) + 1);
      if (!latest.has(attempt.order_id)) latest.set(attempt.order_id, attempt);
    }
    return { latest, counts };
  }

  /** Student view: a coarse stage, never device errors or file paths. */
  private async withFulfillmentStages<T extends { id: string; state: string }>(
    orders: T[],
  ) {
    const ids = orders
      .filter((order) => FULFILLMENT_STATES.has(order.state))
      .map((order) => order.id);
    const { latest } = await this.latestAttempts(ids);
    return orders.map((order) => ({
      ...order,
      fulfillment_stage: fulfillmentStage(order.state, latest.get(order.id)),
    }));
  }
}
