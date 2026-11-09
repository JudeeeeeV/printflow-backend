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
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { throwIfReadFailed } from '../common/upstream-failure';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import {
  assertFileSignature,
  IMAGE_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  PRINTABLE_DOCUMENT_MIME_TYPES,
  secureObjectName,
} from '../common/upload-security';
import {
  PrintableDocumentService,
  type PrintOrientation,
} from './printable-document.service';
import {
  DocumentUploadException,
  documentUploadError,
} from '../common/document-upload-error';
import { validateStoredOrderDocument } from './stored-order-document';
import { isShopOpenNow } from '../shops/shop-availability';
import { applyOrderDecision, type PaymentOrder } from './payment-workflow';
import {
  OrderOperations,
  operationFingerprint,
  sha256,
  type OperationClaim,
} from './order-operations';
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
  draft_version?: number;
}

interface SubmittedDraftRow {
  state: string;
  shop_id: string;
  paper_size: string;
  print_color_mode: string;
  orientation?: PrintOrientation | null;
  copies?: number | null;
  draft_version: number;
}

type DraftSettings = Omit<UpdateDraftDto, 'expectedVersion'>;

export interface CreatedOrderResult {
  message: string;
  orderId: string;
  state: string;
  order: PaymentOrder;
}
export type DraftChangeResult = CreatedOrderResult;
export type ReceiptResult = Omit<CreatedOrderResult, 'orderId'>;

/** How long a repeat of the same file to the same shop prompts for confirmation. */
const DUPLICATE_WINDOW_MS = 30 * 60_000;

interface ShopPricingRow {
  pricing_matrix: {
    paper_sizes?: Record<string, number>;
    color_mode_multipliers?: Record<string, number>;
  } | null;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly operations: OrderOperations;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly printableDocuments: PrintableDocumentService,
  ) {
    this.operations = new OrderOperations(supabaseService);
  }

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
    let bytes: Buffer;
    try {
      const supabase = this.supabaseService.getAdminClient();
      const { data: asset, error } = await supabase
        .from('assets')
        .select('file_url, file_type')
        .eq('order_id', orderId)
        .limit(1)
        .single<{ file_url: string; file_type: string }>();
      if (error || !asset || asset.file_type !== 'PDF')
        throw new DocumentUploadException('DRAFT_FILE_UNAVAILABLE');
      const path = this.supabaseService.storagePath(asset.file_url, 'assets');
      if (!path) throw new DocumentUploadException('DRAFT_FILE_UNAVAILABLE');
      const { data: blob, error: downloadError } = await supabase.storage
        .from('assets')
        .download(path);
      if (downloadError || !blob)
        throw new DocumentUploadException('DRAFT_FILE_UNAVAILABLE');
      bytes = Buffer.from(await blob.arrayBuffer());
    } catch {
      throw new DocumentUploadException('DRAFT_FILE_UNAVAILABLE');
    }
    try {
      // The stored document was normalized during upload. Validate and count it
      // without rebuilding every page just to inspect an existing order.
      return await this.printableDocuments.getPdfPageCount(bytes);
    } catch (error) {
      throw documentUploadError(error);
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

    throwIfReadFailed(error);
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
          `id, total, created_at, shop_id, shops(name), ${assetColumns}, paper_size, print_color_mode, page_count, order_name, orientation, copies, payment_method, draft_version`,
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
          draftVersion: order.draft_version,
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

  async updateDraft(
    userId: string,
    draftId: string,
    payload: UpdateDraftDto,
    file?: Express.Multer.File,
    operationKey: string = randomUUID(),
  ) {
    const contentHash = file ? this.assertPrintableUpload(file) : null;
    const { expectedVersion, ...settings } = payload;
    return this.operations.run<DraftChangeResult>(
      {
        userId,
        key: operationKey,
        action: 'UPDATE_DRAFT',
        targetId: draftId,
        contentHash,
        fingerprint: operationFingerprint({
          settings,
          expectedVersion,
          contentHash,
        }),
      },
      (claim) =>
        this.changeDraft(claim, userId, draftId, {
          settings,
          expectedVersion,
          file,
          submit: false,
        }),
    );
  }

  async submitDraft(
    userId: string,
    draftId: string,
    paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP',
    options: {
      settings?: DraftSettings;
      expectedVersion?: number;
      file?: Express.Multer.File;
      operationKey?: string;
    } = {},
  ) {
    const { settings, expectedVersion, file } = options;
    const contentHash = file ? this.assertPrintableUpload(file) : null;
    return this.operations.run<DraftChangeResult>(
      {
        userId,
        key: options.operationKey ?? randomUUID(),
        action: 'SUBMIT_DRAFT',
        targetId: draftId,
        contentHash,
        fingerprint: operationFingerprint({
          settings,
          paymentMethod,
          expectedVersion,
          contentHash,
        }),
      },
      (claim) =>
        this.changeDraft(claim, userId, draftId, {
          settings,
          paymentMethod,
          expectedVersion,
          file,
          submit: true,
        }),
    );
  }

  /** Saves or submits a draft in place, in one transaction. */
  private async changeDraft(
    claim: OperationClaim,
    userId: string,
    draftId: string,
    change: {
      settings?: DraftSettings;
      paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP';
      expectedVersion?: number;
      file?: Express.Multer.File;
      submit: boolean;
    },
  ): Promise<DraftChangeResult> {
    const supabase = this.supabaseService.getAdminClient();
    const { settings, file, submit } = change;

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select(
        'state, shop_id, paper_size, print_color_mode, orientation, copies, draft_version',
      )
      .eq('id', draftId)
      .eq('client_id', userId)
      .single<SubmittedDraftRow>();

    throwIfReadFailed(fetchError);
    if (fetchError || !order) {
      if (submit) throw new NotFoundException('Draft not found');
      throw new BadRequestException('Draft not found or not in draft state.');
    }
    if (order.state !== 'DRAFT') {
      if (submit) throw new BadRequestException('Order is not a draft.');
      throw new BadRequestException('Draft not found or not in draft state.');
    }
    if (
      change.expectedVersion !== undefined &&
      change.expectedVersion !== order.draft_version
    ) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message:
          'This draft changed while you were editing. Reload it and try again.',
      });
    }

    const shopId = settings?.shopId ?? order.shop_id;
    const paperSize = settings?.paperSize ?? order.paper_size;
    const colorMode = settings?.printColorMode ?? order.print_color_mode;
    const copies = settings?.copies ?? order.copies ?? 1;
    const orientation = (settings?.orientation ??
      order.orientation ??
      'PORTRAIT') as PrintOrientation;

    await this.requireVerifiedShop(shopId);
    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select(
        'pricing_matrix, availability_override, opens_at, closes_at, timezone',
      )
      .eq('id', shopId)
      .single();
    if (shopError || !shop)
      throw new BadRequestException('Shop is unavailable');
    if (submit && !isShopOpenNow(shop))
      throw new BadRequestException('Shop is currently closed');

    let pageCount: number;
    let asset: Record<string, unknown> | undefined;
    if (file) {
      const printable = await this.printableDocuments
        .normalize(file, paperSize, orientation)
        .catch((error: unknown) => {
          throw documentUploadError(error);
        });
      pageCount = printable.pageCount;
      asset = await this.storePrintable(
        claim,
        `${userId}/${draftId}`,
        printable.buffer,
        file,
      );
    } else {
      pageCount = await this.getAssetPageCount(draftId);
    }

    const total = this.calculatePrice(
      shop.pricing_matrix,
      paperSize,
      colorMode,
      pageCount,
      copies,
    );
    const paymentMethod = settings?.paymentMethod ?? change.paymentMethod;

    const { result, replacedPaths } = await claim.commit<DraftChangeResult>({
      message: submit
        ? 'Draft submitted successfully'
        : 'Draft updated successfully',
      expectedVersion: change.expectedVersion ?? order.draft_version,
      order: {
        shop_id: shopId,
        paper_size: paperSize,
        print_color_mode: colorMode,
        total,
        page_count: pageCount,
        ...(paymentMethod ? { payment_method: paymentMethod } : {}),
        ...(settings ? { order_name: settings.orderName.trim() } : {}),
        orientation,
        copies,
      },
      ...(asset ? { asset } : {}),
    });

    if (replacedPaths.length) {
      // The commit no longer references these, so a failure only wastes space.
      const { error } = await supabase.storage
        .from('assets')
        .remove(replacedPaths);
      if (error) this.logger.warn('Could not remove a replaced draft file.');
    }
    return result;
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

  /** Checks only the upload itself, so the outcome depends on the inputs alone. */
  private assertPrintableUpload(file: Express.Multer.File): string {
    if (
      !PRINTABLE_DOCUMENT_MIME_TYPES.includes(
        file.mimetype as (typeof PRINTABLE_DOCUMENT_MIME_TYPES)[number],
      )
    )
      throw new DocumentUploadException('UNSUPPORTED_FILE');
    if (!file.buffer?.length) throw new DocumentUploadException('EMPTY_FILE');
    if (file.buffer.length > MAX_DOCUMENT_BYTES)
      throw new DocumentUploadException('FILE_TOO_LARGE');
    try {
      assertFileSignature(file, PRINTABLE_DOCUMENT_MIME_TYPES);
    } catch (error) {
      throw documentUploadError(error);
    }
    return sha256(file.buffer);
  }

  /** The path is fixed per operation, so a retry replaces rather than strands. */
  private async storePrintable(
    claim: OperationClaim,
    prefix: string,
    buffer: Buffer,
    file: Express.Multer.File,
  ): Promise<Record<string, unknown>> {
    try {
      await this.ensureAssetsBucket();
      const originalFileName =
        file.originalname.split(/[\\/]/).pop()?.replaceAll('\0', '').trim() ||
        null;
      const path = `${prefix}/${claim.key}.pdf`;
      await claim.stage('assets', path);
      const { error: uploadError } = await this.supabaseService
        .getAdminClient()
        .storage.from('assets')
        .upload(path, buffer, {
          contentType: 'application/pdf',
          upsert: true,
          metadata: originalFileName ? { originalFileName } : undefined,
        });
      if (uploadError) throw new DocumentUploadException('UPLOAD_FAILED');
      return {
        path,
        dpi: 300, // Baseline required by application logic
        fileType: 'PDF',
        originalFilename: originalFileName,
      };
    } catch {
      throw new DocumentUploadException('UPLOAD_FAILED');
    }
  }

  async createOrder(
    userId: string,
    payload: CreateOrderDto,
    file: Express.Multer.File,
    operationKey: string = randomUUID(),
  ) {
    const contentHash = this.assertPrintableUpload(file);
    // Evaluate the string sent by FormData
    const isDraftOrder = payload.isDraft === 'true';
    const { confirmDuplicate, ...inputs } = payload;
    const request = {
      userId,
      key: operationKey,
      action: isDraftOrder ? 'CREATE_DRAFT' : 'CREATE_ORDER',
      targetId: payload.shopId,
      contentHash,
      fingerprint: operationFingerprint({ ...inputs, contentHash }),
    } as const;

    return this.operations.run<CreatedOrderResult>(request, async (claim) => {
      if (!isDraftOrder && confirmDuplicate !== 'true') {
        const duplicateId = await this.operations.findRecentDuplicate(
          request,
          DUPLICATE_WINDOW_MS,
        );
        if (duplicateId) {
          throw new ConflictException({
            code: 'POSSIBLE_DUPLICATE',
            orderId: duplicateId,
            message: 'You recently submitted this file to this shop.',
          });
        }
      }

      const supabase = this.supabaseService.getAdminClient();
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

      const printable = await this.printableDocuments
        .normalize(file, payload.paperSize, payload.orientation)
        .catch((error: unknown) => {
          throw documentUploadError(error);
        });
      const pageCount = printable.pageCount;
      const calculatedTotal = this.calculatePrice(
        (shop as unknown as ShopPricingRow).pricing_matrix,
        payload.paperSize,
        payload.printColorMode,
        pageCount,
        payload.copies,
      );

      // Store a normalized PDF so every printer agent receives one format.
      const asset = await this.storePrintable(
        claim,
        `${userId}/${claim.plannedOrderId}`,
        printable.buffer,
        file,
      );
      const { result } = await claim.commit<CreatedOrderResult>({
        message: 'Order created successfully',
        order: {
          state: isDraftOrder ? 'DRAFT' : 'OPEN_INQUIRY',
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
        },
        asset,
      });
      return result;
    });
  }

  operationStatus(userId: string, operationKey: string) {
    return this.operations.status(userId, operationKey);
  }

  @Cron(CronExpression.EVERY_HOUR)
  sweepOrderOperations() {
    return this.operations.sweep();
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
    operationKey: string = randomUUID(),
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
    const reference = referenceNumber.trim();
    const contentHash = sha256(file.buffer);
    return this.operations.run<ReceiptResult>(
      {
        userId,
        key: operationKey,
        action: 'UPLOAD_RECEIPT',
        targetId: orderId,
        contentHash,
        fingerprint: operationFingerprint({ reference, contentHash }),
      },
      async (claim) => {
        const supabase = this.supabaseService.getAdminClient();
        const { data: owner, error } = await supabase
          .from('orders')
          .select('id, payment_method, payment_status, state, expires_at')
          .eq('id', orderId)
          .eq('client_id', userId)
          .single();
        throwIfReadFailed(error);
        if (error || !owner) throw new NotFoundException('Order not found.');
        // Reject obviously ineligible uploads before writing an unreferenced object.
        // The locked decision RPC remains authoritative when the order changes concurrently.
        if (
          owner.payment_method !== 'GCASH' ||
          ['DRAFT', 'CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED'].includes(
            owner.state,
          ) ||
          !['UNPAID', 'REJECTED', 'REVIEW_REQUIRED'].includes(
            owner.payment_status,
          ) ||
          (owner.expires_at &&
            new Date(owner.expires_at).getTime() <= Date.now())
        ) {
          throw new ConflictException(
            'Receipt submission is not available for this order. Refresh its status.',
          );
        }
        await this.ensureReceiptsBucket();
        const extension = secureObjectName('', file.mimetype).split('.').pop();
        const fileName = `${userId}/${orderId}/${claim.key}.${extension}`;
        await claim.stage('receipts', fileName);
        const { error: uploadError } = await supabase.storage
          .from('receipts')
          .upload(fileName, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });
        if (uploadError)
          throw new InternalServerErrorException(
            'The receipt image could not be stored.',
          );
        const { result } = await claim.commit<ReceiptResult>({
          message: 'Receipt saved. Awaiting payment verification.',
          receiptPath: fileName,
          reference,
        });
        return result;
      },
    );
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
    throwIfReadFailed(error);
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
