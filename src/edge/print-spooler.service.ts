import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintAssetService, type PinnedPrintable } from './print-asset.service';
import {
  fulfillmentError,
  presentAttempt,
  type PrintAttemptRow,
} from '../orders/print-fulfillment';

interface PrintOrder {
  id: string;
  state: string;
  order_name?: string | null;
  print_color_mode: string;
  paper_size: string;
  orientation: 'PORTRAIT' | 'LANDSCAPE' | null;
  copies: number | null;
  assets: Array<{ file_url: string }>;
}

type ExecutionMode = 'AGENT' | 'MANUAL';

interface Dispatch {
  order: PrintOrder;
  printable: PinnedPrintable;
  settings: Record<string, unknown>;
  revisionId: string;
}

const ORDER_COLUMNS =
  'id, state, order_name, print_color_mode, paper_size, orientation, copies, assets(file_url)';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

@Injectable()
export class PrintSpoolerService {
  private readonly logger = new Logger(PrintSpoolerService.name);

  constructor(
    private readonly gateway: EdgeDaemonGateway,
    private readonly printJobsRepo: PrintJobsRepository,
    private readonly supabaseService: SupabaseService,
    private readonly printAssets: PrintAssetService,
  ) {}

  /** Initial automated dispatch of reviewed orders. Idempotent per request ID. */
  async executeBatch(input: {
    orderIds: string[];
    shopId: string;
    actorId: string;
    printerName?: string;
    requestId?: string;
  }) {
    const orderIds = [...new Set(input.orderIds)].sort();
    await this.requireVerifiedShop(input.shopId);
    return this.idempotent(
      input,
      { mode: 'AGENT', orderIds, printerName: input.printerName ?? null },
      async (requestId) => {
        const agent = this.requireAgent(input.shopId, input.printerName);
        await this.supabaseService.ensurePrivateBucket('assets');
        const { dispatches, skipped } = await this.prepareInitial(
          input.shopId,
          orderIds,
        );
        const created = await this.createAttempts(
          dispatches,
          {
            shopId: input.shopId,
            actorId: input.actorId,
            mode: 'AGENT',
            deviceId: agent.deviceId,
            printerName: input.printerName ?? null,
            batchRequestId: requestId,
          },
          skipped,
        );
        await this.deliver(input.shopId, agent.deviceId, created);
        return {
          message:
            'Print attempts recorded and sent to the printer agent. Check each output before marking it ready.',
          requestId,
          deviceId: agent.deviceId,
          printerName: input.printerName ?? null,
          spooledCount: created.length,
          attempts: created.map((attempt) => presentAttempt(attempt)),
          skipped,
        };
      },
    );
  }

  /**
   * Reviewed manual fallback. The attempt is recorded before the pinned file is
   * returned; downloading never establishes output completion.
   */
  async startManualProduction(input: {
    orderIds: string[];
    shopId: string;
    actorId: string;
    requestId?: string;
  }) {
    const orderIds = [...new Set(input.orderIds)].sort();
    await this.requireVerifiedShop(input.shopId);
    const result = await this.idempotent(
      input,
      { mode: 'MANUAL', orderIds },
      async (requestId) => {
        await this.supabaseService.ensurePrivateBucket('assets');
        const { dispatches, skipped } = await this.prepareInitial(
          input.shopId,
          orderIds,
        );
        const created = await this.createAttempts(
          dispatches,
          {
            shopId: input.shopId,
            actorId: input.actorId,
            mode: 'MANUAL',
            deviceId: null,
            printerName: null,
            batchRequestId: requestId,
          },
          skipped,
        );
        created.forEach((attempt) =>
          this.gateway.broadcastAttempt(input.shopId, attempt),
        );
        return {
          message:
            'Manual production recorded. Print the files, then check each output before marking it ready.',
          requestId,
          attempts: created.map((attempt) => presentAttempt(attempt)),
          skipped,
        };
      },
    );
    // Signed links are never stored; issue fresh ones for every (re)play.
    return this.withDownloads(input.shopId, result);
  }

  /** Operator retry of a failed, uncertain, or stalled attempt. */
  async retryAttempt(input: {
    attemptId: string;
    shopId: string;
    actorId: string;
    mode: ExecutionMode;
    printerName?: string;
    reason?: string;
    queueCleared?: boolean;
  }) {
    await this.requireVerifiedShop(input.shopId);
    const previous = await this.printJobsRepo.findAttempt(
      input.attemptId,
      input.shopId,
    );
    if (!previous) throw fulfillmentError('ATTEMPT_NOT_FOUND');
    if (previous.resolved_at) throw fulfillmentError('ATTEMPT_NOT_CURRENT');
    const printerName =
      input.mode === 'AGENT'
        ? (input.printerName ?? previous.printer_name ?? undefined)
        : undefined;
    const agent =
      input.mode === 'AGENT'
        ? this.requireAgent(input.shopId, printerName)
        : null;
    const order = await this.loadOrder(input.shopId, previous.order_id);
    const dispatch = await this.dispatchFrom(input.shopId, order, previous);
    return this.createFollowUp(input, dispatch, {
      kind: 'RETRY',
      previousAttemptId: previous.attempt_id,
      deviceId: agent?.deviceId ?? null,
      printerName: printerName ?? null,
      reason: input.reason,
      queueCleared: input.queueCleared,
    });
  }

  /** A recorded full reprint before handover, without a new charge. */
  async reprintOrder(input: {
    orderId: string;
    shopId: string;
    actorId: string;
    expectedAttemptId: string | null;
    mode: ExecutionMode;
    printerName?: string;
    reason: string;
    confirmFullJob: boolean;
  }) {
    if (input.confirmFullJob !== true)
      throw new BadRequestException(
        'Confirm that the entire approved job, including every copy, will be printed again.',
      );
    await this.requireVerifiedShop(input.shopId);
    const previous = input.expectedAttemptId
      ? await this.printJobsRepo.findAttempt(
          input.expectedAttemptId,
          input.shopId,
        )
      : null;
    if (input.expectedAttemptId && !previous)
      throw fulfillmentError('ATTEMPT_NOT_CURRENT');
    if (previous && previous.order_id !== input.orderId)
      throw fulfillmentError('ATTEMPT_NOT_CURRENT');
    const printerName =
      input.mode === 'AGENT'
        ? (input.printerName ?? previous?.printer_name ?? undefined)
        : undefined;
    const agent =
      input.mode === 'AGENT'
        ? this.requireAgent(input.shopId, printerName)
        : null;
    const order = await this.loadOrder(input.shopId, input.orderId);
    const dispatch = await this.dispatchFrom(input.shopId, order, previous);
    return this.createFollowUp(input, dispatch, {
      kind: 'REPRINT',
      previousAttemptId: input.expectedAttemptId,
      deviceId: agent?.deviceId ?? null,
      printerName: printerName ?? null,
      reason: input.reason,
    });
  }

  /** "Outcome is still uncertain": record the inspection, keep the order blocked. */
  async recordStillUncertain(input: {
    attemptId: string;
    shopId: string;
    actorId: string;
    reason: string;
  }) {
    await this.requireVerifiedShop(input.shopId);
    const result = await this.printJobsRepo.recordReconciliationNote(
      input.attemptId,
      input.shopId,
      input.actorId,
      input.reason,
    );
    if (!result.ok) throw fulfillmentError(result.code);
    return {
      message:
        'Inspection recorded. The order stays blocked until the outcome is resolved.',
    };
  }

  async history(shopId: string, orderId: string) {
    await this.requireVerifiedShop(shopId);
    const history = await this.printJobsRepo.history(shopId, orderId);
    return {
      attempts: history.attempts.map((attempt) => presentAttempt(attempt)),
      events: history.events,
      fulfillment: history.fulfillment,
    };
  }

  // --- internals -------------------------------------------------------------

  private async createFollowUp(
    input: {
      shopId: string;
      actorId: string;
      mode: ExecutionMode;
    },
    dispatch: Dispatch,
    options: {
      kind: 'RETRY' | 'REPRINT';
      previousAttemptId: string | null;
      deviceId: string | null;
      printerName: string | null;
      reason?: string | null;
      queueCleared?: boolean;
    },
  ) {
    const result = await this.printJobsRepo.createAttempt({
      orderId: dispatch.order.id,
      shopId: input.shopId,
      kind: options.kind,
      mode: input.mode,
      previousAttemptId: options.previousAttemptId,
      revisionId: dispatch.revisionId,
      printable: dispatch.printable,
      deviceId: options.deviceId,
      printerName: options.printerName,
      settings: dispatch.settings,
      batchRequestId: null,
      actorId: input.actorId,
      reason: options.reason,
      queueCleared: options.queueCleared,
    });
    if (!result.ok || !result.attempt) throw fulfillmentError(result.code);
    const attempt = result.attempt;
    if (input.mode === 'AGENT' && options.deviceId) {
      await this.deliver(input.shopId, options.deviceId, [attempt]);
    } else {
      this.gateway.broadcastAttempt(input.shopId, attempt);
    }
    const response: Record<string, unknown> = {
      message:
        options.kind === 'REPRINT'
          ? 'Reprint recorded. Check the new output before marking it ready.'
          : 'Retry recorded. Check the output before marking it ready.',
      attempt: presentAttempt(attempt),
    };
    if (input.mode === 'MANUAL') {
      response.download = {
        url: await this.printAssets.sign(dispatch.printable.path),
        fileName: this.downloadName(dispatch.order),
      };
    }
    return response;
  }

  /** Pinned file and settings for a retry or reprint: the locked revision. */
  private async dispatchFrom(
    shopId: string,
    order: PrintOrder,
    previous: PrintAttemptRow | null,
  ): Promise<Dispatch> {
    const revisionId = this.revisionOf(order);
    if (previous?.revision_id && previous.revision_id !== revisionId)
      throw fulfillmentError('REVISION_CHANGED');
    const settings = previous?.print_settings ?? this.settingsOf(order);
    if (
      previous?.printable_path &&
      previous.printable_sha256 &&
      previous.printable_size !== null
    ) {
      return {
        order,
        revisionId,
        settings,
        printable: {
          path: previous.printable_path,
          sha256: previous.printable_sha256,
          size: Number(previous.printable_size),
        },
      };
    }
    // Legacy attempts carry no pinned file; derive it from the stored asset.
    await this.supabaseService.ensurePrivateBucket('assets');
    return {
      order,
      revisionId,
      settings,
      printable: await this.printAssets.preparePinned(
        order.assets[0].file_url,
        shopId,
        order.id,
        order.paper_size,
        order.orientation || 'PORTRAIT',
      ),
    };
  }

  private async prepareInitial(shopId: string, orderIds: string[]) {
    const orders = await this.loadOrders(shopId, orderIds);
    const skipped: Array<{ orderId: string; code: string }> = [];
    const found = new Set(orders.map((order) => order.id));
    for (const id of orderIds)
      if (!found.has(id))
        skipped.push({ orderId: id, code: 'ORDER_NOT_FOUND' });
    const inProduction = orders.filter((order) => {
      if (order.state === 'IN_PRODUCTION') return true;
      skipped.push({ orderId: order.id, code: 'ORDER_NOT_PRINTABLE' });
      return false;
    });
    if (inProduction.length === 0)
      throw new NotFoundException(
        'No valid IN_PRODUCTION orders found for this batch',
      );
    const open = new Set(
      (
        await this.printJobsRepo.findOpenAttempts(
          shopId,
          inProduction.map((order) => order.id),
        )
      ).map((attempt) => attempt.order_id),
    );
    const eligible = inProduction.filter((order) => {
      if (!open.has(order.id)) return true;
      skipped.push({ orderId: order.id, code: 'ATTEMPT_OPEN' });
      return false;
    });
    // Prepare every file before recording attempts so a conversion failure
    // cannot leave earlier orders claimed without being dispatched.
    const dispatches: Dispatch[] = [];
    for (const order of eligible) {
      const assetUrl = order.assets?.[0]?.file_url;
      if (!assetUrl) {
        this.logger.warn(`Order ${order.id} has no asset URL, skipping.`);
        skipped.push({ orderId: order.id, code: 'NO_PRINT_FILE' });
        continue;
      }
      dispatches.push({
        order,
        revisionId: this.revisionOf(order),
        settings: this.settingsOf(order),
        printable: await this.printAssets.preparePinned(
          assetUrl,
          shopId,
          order.id,
          order.paper_size,
          order.orientation || 'PORTRAIT',
        ),
      });
    }
    if (dispatches.length === 0)
      throw new ConflictException(
        'No printable orders are available, or the selected orders already have unresolved print attempts.',
      );
    return { dispatches, skipped };
  }

  private async createAttempts(
    dispatches: Dispatch[],
    options: {
      shopId: string;
      actorId: string;
      mode: ExecutionMode;
      deviceId: string | null;
      printerName: string | null;
      batchRequestId: string;
    },
    skipped: Array<{ orderId: string; code: string }>,
  ) {
    const created: PrintAttemptRow[] = [];
    for (const dispatch of dispatches) {
      const result = await this.printJobsRepo.createAttempt({
        orderId: dispatch.order.id,
        shopId: options.shopId,
        kind: 'INITIAL',
        mode: options.mode,
        previousAttemptId: null,
        revisionId: dispatch.revisionId,
        printable: dispatch.printable,
        deviceId: options.deviceId,
        printerName: options.printerName,
        settings: dispatch.settings,
        batchRequestId: options.batchRequestId,
        actorId: options.actorId,
      });
      if (result.ok && result.attempt) created.push(result.attempt);
      else
        skipped.push({
          orderId: dispatch.order.id,
          code: result.code || 'UNKNOWN',
        });
    }
    if (created.length === 0)
      throw new ConflictException(
        'No printable orders are available, or the selected orders already have unresolved print attempts.',
      );
    return created;
  }

  private async deliver(
    shopId: string,
    deviceId: string,
    attempts: PrintAttemptRow[],
  ) {
    const commands = await Promise.all(
      attempts.map((attempt) => this.gateway.buildCommand(attempt)),
    );
    this.logger.log(
      `Emitting ${commands.length} print attempt(s) to device ${deviceId} for shop ${shopId}`,
    );
    if (this.gateway.emitPrintCommands(shopId, deviceId, commands)) {
      attempts.forEach((attempt) =>
        this.gateway.broadcastAttempt(shopId, attempt),
      );
      return;
    }
    // Nothing reached the agent: record a known pre-submission failure.
    const ids = attempts.map((attempt) => attempt.attempt_id);
    await this.printJobsRepo.markUndelivered(
      ids,
      shopId,
      'AGENT_DISCONNECTED',
      'The printer agent disconnected before the command was delivered.',
    );
    const failed = await this.printJobsRepo.findAttempts(ids, shopId);
    failed.forEach((attempt) => this.gateway.broadcastAttempt(shopId, attempt));
    throw new ConflictException({
      statusCode: 409,
      message:
        'The PrintFlow Agent disconnected before dispatch. Nothing was sent; wait for it to reconnect, then retry the failed attempts.',
      attempts: failed.map((attempt) => presentAttempt(attempt)),
    });
  }

  private requireAgent(shopId: string, printerName?: string) {
    if (!this.gateway.hasConnectedDaemon(shopId)) {
      throw new ConflictException(
        'The PrintFlow Agent is offline. Wait for it to reconnect before sending orders.',
      );
    }
    const agent = this.gateway.getConnectedAgent(shopId);
    if (!agent?.supportsAttempts || !agent.deviceId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'AGENT_UPDATE_REQUIRED',
        message:
          'Agent update required. Install the latest PrintFlow Agent from the Printer Agent page, or use manual production.',
      });
    }
    const printers = this.gateway.getAvailablePrinters(shopId);
    if (printers.length === 0) {
      throw new ConflictException(
        'The PrintFlow Agent has not reported any printers. Wait for discovery or use Rescan on the Printer Agent page.',
      );
    }
    if (printerName && !printers.includes(printerName)) {
      throw new BadRequestException(
        'The selected printer is no longer available. Select a detected printer and try again.',
      );
    }
    return { deviceId: agent.deviceId };
  }

  private async idempotent(
    input: { shopId: string; actorId: string; requestId?: string },
    contents: Record<string, unknown>,
    run: (requestId: string) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const requestId = input.requestId ?? randomUUID();
    const begun = await this.printJobsRepo.beginBatchRequest(
      requestId,
      input.shopId,
      sha256(JSON.stringify(contents)),
      input.actorId,
    );
    if (begun.state === 'CONFLICT')
      throw new ConflictException(
        'This request was already used for a different selection. Review the batch again.',
      );
    if (begun.state === 'IN_PROGRESS')
      throw new ConflictException(
        'This batch is already being processed. Refresh the queue to see its progress.',
      );
    if (begun.state === 'DONE') {
      const recorded = begun.response || {};
      if (begun.status === 'FAILED') {
        throw new HttpException(
          (recorded.body as Record<string, unknown>) || 'Batch failed',
          Number(recorded.statusCode) || 409,
        );
      }
      return { ...recorded, replayed: true };
    }
    try {
      const result = await run(requestId);
      await this.printJobsRepo.completeBatchRequest(
        requestId,
        input.shopId,
        'COMPLETED',
        result,
      );
      return result;
    } catch (error) {
      const statusCode =
        error instanceof HttpException ? error.getStatus() : 500;
      const body =
        error instanceof HttpException
          ? error.getResponse()
          : { statusCode, message: 'The batch could not be processed.' };
      await this.printJobsRepo
        .completeBatchRequest(requestId, input.shopId, 'FAILED', {
          statusCode,
          body: typeof body === 'string' ? { statusCode, message: body } : body,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private async withDownloads(shopId: string, result: Record<string, unknown>) {
    const presented = (result.attempts || []) as Array<{ attemptId: string }>;
    const rows = await this.printJobsRepo.findAttempts(
      presented.map((attempt) => attempt.attemptId),
      shopId,
    );
    const orders = await this.loadOrders(
      shopId,
      rows.map((row) => row.order_id),
    );
    const names = new Map(orders.map((order) => [order.id, order]));
    const downloads = await Promise.all(
      rows
        .filter((row) => row.printable_path)
        .map(async (row) => {
          const order = names.get(row.order_id);
          return {
            attemptId: row.attempt_id,
            orderId: row.order_id,
            url: await this.printAssets.sign(row.printable_path!),
            fileName: order
              ? this.downloadName(order)
              : `Order_${row.order_id.slice(0, 8)}.pdf`,
          };
        }),
    );
    return { ...result, downloads };
  }

  private async requireVerifiedShop(shopId: string) {
    const { data: shop, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select('id')
      .eq('id', shopId)
      .eq('verification_status', 'VERIFIED')
      .single();
    if (error || !shop) throw new NotFoundException('Verified shop not found');
  }

  private async loadOrders(shopId: string, orderIds: string[]) {
    if (orderIds.length === 0) return [];
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('shop_id', shopId)
      .in('id', orderIds);
    if (error || !data)
      throw new InternalServerErrorException(
        'Failed to validate orders for batch printing',
      );
    return data as unknown as PrintOrder[];
  }

  private async loadOrder(shopId: string, orderId: string) {
    const [order] = await this.loadOrders(shopId, [orderId]);
    if (!order) throw fulfillmentError('ORDER_NOT_FOUND');
    if (!order.assets?.[0]?.file_url)
      throw new BadRequestException('The print file is unavailable');
    return order;
  }

  /** The order's locked source file identifies its approved revision. */
  private revisionOf(order: PrintOrder) {
    const path = order.assets?.[0]?.file_url;
    if (!path) throw new BadRequestException('The print file is unavailable');
    return this.supabaseService.storagePath(path, 'assets') || path;
  }

  private settingsOf(order: PrintOrder) {
    return {
      colorMode: order.print_color_mode,
      paperSize: order.paper_size,
      orientation: order.orientation || 'PORTRAIT',
      copies: order.copies ?? 1,
    };
  }

  private downloadName(order: PrintOrder) {
    const label = (order.order_name || 'document')
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 60);
    return `Order_${order.id.slice(0, 8)}_${label}.pdf`;
  }
}
