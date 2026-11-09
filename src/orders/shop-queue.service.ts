import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { presentAttempt, type PrintAttemptRow } from './print-fulfillment';
import { ShopQueueQueryDto } from './dto/shop-queue.dto';

export interface QueueRow {
  id: string;
  state: string;
  order_name: string | null;
  client_name: string | null;
  paper_size: string | null;
  print_color_mode: string | null;
  orientation: string | null;
  page_count: number | null;
  copies: number | null;
  payment_method: string;
  payment_status: string;
  acceptance_status: string;
  fingerprint: string;
  source_path: string | null;
  has_document: boolean;
  selectable: boolean;
  blocking_reasons: string[];
  available_actions: string[];
  raw_attempt: PrintAttemptRow | null;
  assets: { original_filename: string | null; file_url?: string | null }[];
}

export function queueAttempt(attempt: PrintAttemptRow) {
  const { revisionId, ...publicAttempt } = presentAttempt(attempt);
  void revisionId;
  return publicAttempt;
}

export function queueSummary(row: QueueRow) {
  const { source_path, raw_attempt, ...summary } = row;
  void source_path;
  return {
    ...summary,
    current_attempt: raw_attempt ? queueAttempt(raw_attempt) : null,
  };
}

@Injectable()
export class ShopQueueService {
  constructor(private readonly supabase: SupabaseService) {}

  async requireShop(shopId: string) {
    const { data, error }: { data: unknown; error: unknown } =
      await this.supabase
        .getAdminClient()
        .from('shops')
        .select('id')
        .eq('id', shopId)
        .eq('verification_status', 'VERIFIED')
        .maybeSingle();
    if (error)
      throw new InternalServerErrorException(
        'Shop eligibility could not be checked.',
      );
    if (!data) throw new NotFoundException('Verified shop not found.');
  }

  async query(shopId: string, query: ShopQueueQueryDto) {
    await this.requireShop(shopId);
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo)
      throw new BadRequestException(
        'The start date must not follow the end date.',
      );
    query.search = query.search?.trim();
    const response: unknown = await this.supabase
      .getAdminClient()
      .rpc('shop_queue_query', { p_shop: shopId, p_query: query });
    const { data, error } = response as { data: unknown; error: unknown };
    if (error || !data)
      throw new InternalServerErrorException(
        'The shop queue could not be loaded.',
      );
    const result = data as {
      data: QueueRow[];
      meta: {
        currentPage: number;
        pageSize: number;
        totalItems: number;
        totalPages: number;
      };
      counts: Record<string, number>;
    };
    return { ...result, data: result.data.map(queueSummary) };
  }

  /** Internal authorized projection; raw file identities never enter queue summaries. */
  async items(shopId: string, ids: string[]): Promise<QueueRow[]> {
    await this.requireShop(shopId);
    if (ids.length === 0) return [];
    const response: unknown = await this.supabase
      .getAdminClient()
      .rpc('shop_queue_rows', { p_shop: shopId, p_ids: ids });
    const { data, error } = response as { data: unknown; error: unknown };
    if (error)
      throw new InternalServerErrorException(
        'The selected orders could not be checked.',
      );
    return (data || []) as QueueRow[];
  }

  async details(shopId: string, orderId: string) {
    await this.requireShop(shopId);
    const response: unknown = await this.supabase
      .getAdminClient()
      .rpc('shop_queue_detail', { p_shop: shopId, p_order: orderId });
    const { data, error } = response as { data: unknown; error: unknown };
    if (error)
      throw new InternalServerErrorException(
        'The order details could not be loaded.',
      );
    if (!data) throw new NotFoundException('Order not found.');
    const detail = data as QueueRow & {
      assets: { file_url: string | null }[];
      payment_receipts: { receipt_url: string | null }[];
    };
    return {
      ...queueSummary(detail),
      assets: await Promise.all(
        (detail.assets || []).map(async (asset) => ({
          ...asset,
          file_url: asset.file_url
            ? await this.supabase.createSignedStorageUrl(
                'assets',
                asset.file_url,
              )
            : null,
        })),
      ),
      payment_receipts: await Promise.all(
        (detail.payment_receipts || []).map(async (receipt) => ({
          ...receipt,
          receipt_url: receipt.receipt_url
            ? await this.supabase.createSignedStorageUrl(
                'receipts',
                receipt.receipt_url,
              )
            : null,
        })),
      ),
    };
  }
}
