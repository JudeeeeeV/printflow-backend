import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ShopQueueService,
  queueSummary,
  queueAttempt,
} from '../orders/shop-queue.service';
import { type PrintAttemptRow } from '../orders/print-fulfillment';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintAssetService, type PinnedPrintable } from './print-asset.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { BatchPreviewDto } from './dto/batch-review.dto';

interface ReviewedItem {
  orderId: string;
  fingerprint: string;
  sourceStored: string;
  sourcePath: string;
  settings: {
    paperSize: string;
    colorMode: string;
    orientation: string;
    copies: number;
  };
  printable: PinnedPrintable;
}
interface Review {
  token: string;
  shop_id: string;
  actor_id: string;
  mode: 'AGENT' | 'MANUAL';
  device_id: string | null;
  printer_name: string | null;
  items: ReviewedItem[];
  expires_at: string;
}
export interface ReviewedExecution {
  shopId: string;
  actorId: string;
  orderIds: string[];
  requestId?: string;
  reviewToken?: string;
  printerName?: string;
  mode: 'AGENT' | 'MANUAL';
}
interface BatchRequest {
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  response: Record<string, unknown> | null;
}

@Injectable()
export class ReviewedBatchService {
  constructor(
    private readonly queue: ShopQueueService,
    private readonly supabase: SupabaseService,
    private readonly files: PrintAssetService,
    private readonly jobs: PrintJobsRepository,
    private readonly gateway: EdgeDaemonGateway,
  ) {}

  private agent(shopId: string, printer?: string) {
    const agent = this.gateway.getConnectedAgent(shopId);
    if (
      !this.gateway.hasConnectedDaemon(shopId) ||
      !agent?.supportsAttempts ||
      !agent.deviceId
    )
      throw new ConflictException(
        'Connect an up-to-date printer agent before sending the batch.',
      );
    if (
      !printer ||
      !this.gateway.getAvailablePrinters(shopId).includes(printer)
    )
      throw new ConflictException(
        'The selected printer is unavailable. Choose a printer and review again.',
      );
    return agent.deviceId;
  }

  private validateIds(ids: string[]) {
    if (ids.length < 1 || ids.length > 25 || new Set(ids).size !== ids.length)
      throw new BadRequestException('Select between 1 and 25 unique orders.');
  }

  async preview(shopId: string, actorId: string, input: BatchPreviewDto) {
    const ids = input.orders.map((item) => item.orderId);
    this.validateIds(ids);
    const rows = new Map(
      (await this.queue.items(shopId, ids)).map((row) => [row.id, row]),
    );
    const blockers: string[] = [];
    let deviceId: string | null = null;
    if (input.mode === 'AGENT') {
      try {
        deviceId = this.agent(shopId, input.printerName);
      } catch (error) {
        blockers.push(
          error instanceof Error ? error.message : 'Printer unavailable.',
        );
      }
    }
    const sizes = new Set([...rows.values()].map((row) => row.paper_size));
    if (
      sizes.size !== 1 ||
      !['SHORT', 'A4', 'LONG'].includes([...sizes][0] || '')
    )
      blockers.push('Every order must use the same known paper size.');
    const items: ReviewedItem[] = [];
    const orders: Record<string, unknown>[] = [];
    let totalPrintedPages = 0;
    for (const selected of input.orders) {
      const row = rows.get(selected.orderId);
      if (!row) {
        orders.push({
          id: selected.orderId,
          selectable: false,
          blocking_reasons: ['Order unavailable for this shop.'],
        });
        continue;
      }
      const reasons = [...row.blocking_reasons];
      if (row.fingerprint !== selected.fingerprint)
        reasons.push(
          'Order details changed since selection. Refresh and review again.',
        );
      if (
        !Number.isInteger(row.page_count) ||
        (row.page_count ?? 0) < 1 ||
        !Number.isInteger(row.copies) ||
        (row.copies ?? 0) < 1 ||
        !['PORTRAIT', 'LANDSCAPE'].includes(row.orientation || '') ||
        !['COLOR', 'BLACK_AND_WHITE'].includes(row.print_color_mode || '')
      )
        reasons.push('Complete, valid print settings are required.');
      if (row.selectable && reasons.length === 0 && row.source_path) {
        try {
          const printable = await this.files.preparePinned(
            row.source_path,
            shopId,
            row.id,
            row.paper_size!,
            row.orientation as 'PORTRAIT' | 'LANDSCAPE',
          );
          items.push({
            orderId: row.id,
            fingerprint: row.fingerprint,
            sourceStored: row.source_path,
            sourcePath: this.supabase.storagePath(row.source_path, 'assets'),
            printable,
            settings: {
              paperSize: row.paper_size!,
              colorMode: row.print_color_mode!,
              orientation: row.orientation!,
              copies: row.copies!,
            },
          });
        } catch {
          reasons.push(
            'The printable file could not be prepared. Check the document and try again.',
          );
        }
      }
      totalPrintedPages += (row.page_count || 0) * (row.copies || 0);
      orders.push({ ...queueSummary(row), blocking_reasons: reasons });
    }
    let reviewToken: string | null = null;
    let expiresAt: string | null = null;
    if (items.length === ids.length && blockers.length === 0) {
      const { data, error }: { data: unknown; error: unknown } =
        await this.supabase
          .getAdminClient()
          .from('print_batch_reviews')
          .insert({
            shop_id: shopId,
            actor_id: actorId,
            mode: input.mode,
            device_id: deviceId,
            printer_name: input.mode === 'AGENT' ? input.printerName : null,
            items,
          })
          .select('token, expires_at')
          .single();
      if (error || !data)
        throw new InternalServerErrorException(
          'The batch review could not be saved.',
        );
      const saved = data as { token: string; expires_at: string };
      reviewToken = saved.token;
      expiresAt = saved.expires_at;
    }
    return {
      orders,
      blockers,
      reviewToken,
      expiresAt,
      mode: input.mode,
      printerName: input.mode === 'AGENT' ? input.printerName : null,
      orderCount: ids.length,
      totalPrintedPages,
    };
  }

  private async loadReview(shopId: string, actorId: string, token: string) {
    const { data, error }: { data: unknown; error: unknown } =
      await this.supabase
        .getAdminClient()
        .from('print_batch_reviews')
        .select('*')
        .eq('token', token)
        .eq('shop_id', shopId)
        .eq('actor_id', actorId)
        .maybeSingle();
    if (error)
      throw new InternalServerErrorException(
        'The review could not be checked.',
      );
    if (!data)
      throw new ConflictException({
        code: 'REVIEW_REQUIRED',
        message: 'Review the selected batch before printing.',
      });
    return data as Review;
  }

  async execute(input: ReviewedExecution) {
    if (!input.reviewToken || !input.requestId)
      throw new BadRequestException({
        code: 'REVIEW_REQUIRED',
        message: 'Review the selected batch before printing.',
      });
    this.validateIds(input.orderIds);
    await this.queue.requireShop(input.shopId);
    const review = await this.loadReview(
      input.shopId,
      input.actorId,
      input.reviewToken,
    );
    if (
      review.mode !== input.mode ||
      JSON.stringify(review.items.map((item) => item.orderId)) !==
        JSON.stringify(input.orderIds) ||
      (input.mode === 'AGENT' && review.printer_name !== input.printerName)
    )
      throw new ConflictException(
        'The selection or printer changed. Review the batch again.',
      );
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          input.reviewToken,
          input.mode,
          input.orderIds,
          input.printerName || null,
        ]),
      )
      .digest('hex');
    const begun = await this.jobs.beginBatchRequest(
      input.requestId,
      input.shopId,
      hash,
      input.actorId,
    );
    if (begun.state === 'CONFLICT')
      throw new ConflictException(
        'This request ID belongs to a different batch.',
      );
    if (begun.state === 'IN_PROGRESS')
      throw new ConflictException({
        code: 'BATCH_PROCESSING',
        message:
          'This batch is processing. Recover its status before sending again.',
      });
    if (begun.state === 'DONE')
      return this.recorded(input.shopId, begun.status!, begun.response || {});

    let claimed = false;
    try {
      if (
        input.mode === 'AGENT' &&
        this.agent(input.shopId, input.printerName) !== review.device_id
      )
        throw new ConflictException(
          'The printing computer changed. Review the batch again.',
        );
      if (Date.parse(review.expires_at) <= Date.now())
        throw new ConflictException(
          'The review expired. Refresh and review again.',
        );
      // Re-read each actual stored file: a changed object at the same path is also a conflict.
      for (const item of review.items) {
        const printable = await this.files.preparePinned(
          item.sourceStored,
          input.shopId,
          item.orderId,
          item.settings.paperSize,
          item.settings.orientation as 'PORTRAIT' | 'LANDSCAPE',
        );
        if (
          printable.sha256 !== item.printable.sha256 ||
          printable.size !== item.printable.size
        )
          throw new ConflictException({
            code: 'BATCH_CHANGED',
            message: 'A reviewed file changed.',
            conflicts: [
              {
                orderId: item.orderId,
                message: 'Review the current file again.',
              },
            ],
          });
      }
      // Recheck the printer immediately before the transaction, not just before file preparation.
      if (
        input.mode === 'AGENT' &&
        this.agent(input.shopId, input.printerName) !== review.device_id
      )
        throw new ConflictException(
          'The printing computer changed. Review again.',
        );
      const rpcResponse: unknown = await this.supabase
        .getAdminClient()
        .rpc('print_claim_reviewed_batch', {
          p_token: review.token,
          p_shop: input.shopId,
          p_actor: input.actorId,
          p_request: input.requestId,
        });
      const { data, error } = rpcResponse as { data: unknown; error: unknown };
      if (
        error &&
        ['55P03', '40001', '23505'].includes(
          (error as { code?: string }).code || '',
        )
      )
        throw new ConflictException(
          'Another action changed this batch. Refresh and review it again.',
        );
      if (error || !data)
        throw new InternalServerErrorException(
          'The batch claim could not be confirmed. Recover its status before sending again.',
        );
      const result = data as {
        ok: boolean;
        code?: string;
        conflicts?: unknown[];
        attempts?: PrintAttemptRow[];
      };
      if (!result.ok)
        throw new ConflictException({
          code: result.code,
          conflicts: result.conflicts,
          message: 'The batch changed. Refresh and review the affected orders.',
        });
      claimed = true;
      let attempts = result.attempts!;
      if (input.mode === 'AGENT')
        attempts = await this.deliver(
          input.shopId,
          review.device_id!,
          attempts,
        );
      else
        attempts.forEach((attempt) =>
          this.gateway.broadcastAttempt(input.shopId, attempt),
        );
      const response = {
        message:
          'Batch accepted. Check physical output before marking it ready.',
        requestId: input.requestId,
        mode: input.mode,
        acceptedOrderIds: attempts.map((attempt) => attempt.order_id),
        spooledCount: attempts.length,
        attempts: attempts.map((attempt) => queueAttempt(attempt)),
        skipped: [],
      };
      await this.jobs.completeBatchRequest(
        input.requestId,
        input.shopId,
        'COMPLETED',
        response,
      );
      return input.mode === 'MANUAL'
        ? this.downloads(input.shopId, response)
        : response;
    } catch (error) {
      // An unconfirmed RPC can have committed. Never record failure until checking durable attempts.
      const attempts = await this.batchAttempts(
        input.shopId,
        input.requestId,
      ).catch(() => null);
      if (!claimed && attempts && attempts.length === 0) {
        const body =
          error instanceof HttpException
            ? error.getResponse()
            : { message: 'The batch could not be processed.' };
        await this.supabase.getAdminClient().rpc('print_fail_reviewed_batch', {
          p_request: input.requestId,
          p_shop: input.shopId,
          p_response: {
            statusCode:
              error instanceof HttpException ? error.getStatus() : 500,
            body: typeof body === 'string' ? { message: body } : body,
          },
        });
      }
      if (claimed || attempts === null || attempts.length > 0) {
        throw new HttpException(
          {
            code: 'BATCH_PROCESSING',
            message:
              'The batch may already be accepted. Recover its recorded outcome before sending again.',
          },
          503,
        );
      }
      throw error;
    }
  }

  private async deliver(
    shopId: string,
    deviceId: string,
    attempts: PrintAttemptRow[],
  ) {
    const commands = await Promise.all(
      attempts.map((attempt) => this.gateway.buildCommand(attempt)),
    );
    if (!this.gateway.emitPrintCommands(shopId, deviceId, commands)) {
      await this.jobs.markUndelivered(
        attempts.map((attempt) => attempt.attempt_id),
        shopId,
        'AGENT_DISCONNECTED',
        'The agent disconnected before delivery.',
      );
    }
    const current = await this.jobs.findAttempts(
      attempts.map((attempt) => attempt.attempt_id),
      shopId,
    );
    current.forEach((attempt) =>
      this.gateway.broadcastAttempt(shopId, attempt),
    );
    const byId = new Map(
      current.map((attempt) => [attempt.attempt_id, attempt]),
    );
    return attempts.map((attempt) => byId.get(attempt.attempt_id) || attempt);
  }

  private async batchAttempts(shopId: string, requestId: string) {
    const { data, error }: { data: unknown; error: unknown } =
      await this.supabase
        .getAdminClient()
        .from('print_jobs')
        .select('*')
        .eq('shop_id', shopId)
        .eq('batch_request_id', requestId)
        .order('id', { ascending: true });
    if (error)
      throw new InternalServerErrorException(
        'Batch progress could not be recovered.',
      );
    return (data || []) as PrintAttemptRow[];
  }

  async recover(shopId: string, requestId: string) {
    await this.queue.requireShop(shopId);
    const expiration: unknown = await this.supabase
      .getAdminClient()
      .rpc('print_expire_unclaimed_batch', {
        p_request: requestId,
        p_shop: shopId,
      });
    if ((expiration as { error: unknown }).error)
      throw new InternalServerErrorException(
        'The pending batch could not be checked. Try recovery again.',
      );
    const { data, error }: { data: unknown; error: unknown } =
      await this.supabase
        .getAdminClient()
        .from('print_batch_requests')
        .select('status,response')
        .eq('request_id', requestId)
        .eq('shop_id', shopId)
        .maybeSingle();
    if (error)
      throw new InternalServerErrorException(
        'The batch outcome could not be recovered.',
      );
    if (!data)
      throw new NotFoundException(
        'No batch request has been recorded yet. Keep the original request ID when retrying.',
      );
    const request = data as BatchRequest;
    const attempts = await this.batchAttempts(shopId, requestId);
    if (attempts.length) {
      const response = {
        requestId,
        attempts: attempts.map((attempt) => queueAttempt(attempt)),
        acceptedOrderIds: attempts.map((attempt) => attempt.order_id),
        skipped: [],
      };
      return {
        status: 'ACCEPTED',
        result:
          attempts[0].execution_mode === 'MANUAL'
            ? await this.downloads(shopId, response)
            : response,
      };
    }
    return {
      status: request.status === 'PENDING' ? 'PROCESSING' : request.status,
      result: request.response,
    };
  }

  private async recorded(
    shopId: string,
    status: string,
    response: Record<string, unknown>,
  ) {
    if (status === 'FAILED')
      throw new HttpException(
        response.body || { message: 'The batch was rejected.' },
        Number(response.statusCode) || 409,
      );
    const replay = { ...response, replayed: true };
    return response.mode === 'MANUAL' ? this.downloads(shopId, replay) : replay;
  }

  private async downloads(shopId: string, response: Record<string, unknown>) {
    const attempts = response.attempts as {
      attemptId: string;
      orderId: string;
    }[];
    const ids = attempts.map((attempt) => attempt.attemptId);
    // Signing/downloading happens after acceptance. A file-link failure must never
    // turn an accepted request into a rejection or invite another production send.
    const rows = await this.jobs.findAttempts(ids, shopId).catch(() => []);
    const map = new Map(rows.map((row) => [row.attempt_id, row]));
    const files = await Promise.all(
      attempts.map(async (attempt) => {
        const row = map.get(attempt.attemptId);
        try {
          if (!row?.printable_path) throw new Error('Pinned file unavailable');
          return {
            file: {
              attemptId: row.attempt_id,
              orderId: row.order_id,
              url: await this.files.sign(row.printable_path),
              fileName: `Order_${row.order_id.slice(0, 8)}.pdf`,
            },
          };
        } catch {
          return {
            error: {
              orderId: attempt.orderId,
              message:
                'The pinned manual file could not be downloaded. Retry downloads for this accepted batch.',
            },
          };
        }
      }),
    );
    return {
      ...response,
      downloads: files.flatMap((item) => (item.file ? [item.file] : [])),
      downloadErrors: files.flatMap((item) => (item.error ? [item.error] : [])),
    };
  }
}
