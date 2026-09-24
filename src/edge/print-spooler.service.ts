import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseService } from '../supabase/supabase.service';

interface PrintOrder {
  id: string;
  state: string;
  print_color_mode: string;
  assets: Array<{ file_url: string }>;
}

@Injectable()
export class PrintSpoolerService {
  private readonly logger = new Logger(PrintSpoolerService.name);
  private readonly recentlyDispatched = new Map<string, number>();

  constructor(
    private readonly gateway: EdgeDaemonGateway,
    private readonly printJobsRepo: PrintJobsRepository,
    private readonly supabaseService: SupabaseService,
  ) {}

  async executeBatch(orderIds: string[], shopId: string, printerName?: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: shop, error: shopError } = await supabase
      .from('shops')
      .select('id')
      .eq('id', shopId)
      .eq('verification_status', 'VERIFIED')
      .single();
    if (shopError || !shop) {
      throw new NotFoundException('Verified shop not found');
    }
    if (!this.gateway.hasConnectedDaemon(shopId)) {
      throw new ConflictException(
        'The PrintFlow Agent is offline. Wait for it to reconnect before sending orders.',
      );
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

    await this.supabaseService.ensurePrivateBucket('assets');

    // Validate that orders are IN_PRODUCTION and belong to this shop
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, state, print_color_mode, assets(file_url)')
      .eq('shop_id', shopId)
      .in('id', orderIds);

    if (error || !orders) {
      throw new InternalServerErrorException(
        'Failed to validate orders for batch printing',
      );
    }

    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [orderId, dispatchedAt] of this.recentlyDispatched) {
      if (dispatchedAt < cutoff) this.recentlyDispatched.delete(orderId);
    }
    const orderRows = orders as unknown as PrintOrder[];
    const validOrders = orderRows.filter(
      (order) =>
        order.state === 'IN_PRODUCTION' &&
        !this.recentlyDispatched.has(order.id),
    );
    if (validOrders.length === 0) {
      throw new NotFoundException(
        'No valid IN_PRODUCTION orders found for this batch',
      );
    }

    const payload: Array<{
      id: string;
      file_url: string;
      print_color_mode: string;
    }> = [];

    for (const order of validOrders) {
      const assetUrl =
        order.assets && order.assets.length > 0
          ? order.assets[0].file_url
          : null;
      if (!assetUrl) {
        this.logger.warn(`Order ${order.id} has no asset URL, skipping.`);
        continue;
      }

      const signedUrl = await this.supabaseService.createSignedStorageUrl(
        'assets',
        assetUrl,
        3600,
      );
      if (!signedUrl) {
        this.logger.warn(
          `Order ${order.id} asset could not be signed, skipping.`,
        );
        continue;
      }

      const claimed = await this.printJobsRepo.claimJob(order.id, shopId);
      if (!claimed) {
        this.logger.warn(`Order ${order.id} already has an active print job.`);
        continue;
      }
      this.recentlyDispatched.set(order.id, Date.now());

      payload.push({
        id: order.id,
        file_url: signedUrl,
        print_color_mode: order.print_color_mode,
      });
    }

    if (payload.length > 0) {
      this.logger.log(
        `Emitting batch_execute for ${payload.length} orders to shop ${shopId} using printer ${printerName || 'default'}`,
      );
      const emitted = this.gateway.emitBatchExecute(shopId, {
        orders: payload,
        printerName,
      });
      if (!emitted) {
        await Promise.all(
          payload.map((order) =>
            this.printJobsRepo.updateJobStatus(order.id, shopId, 'FAILED'),
          ),
        );
        for (const order of payload) this.recentlyDispatched.delete(order.id);
        throw new ConflictException(
          'The PrintFlow Agent disconnected before dispatch. Wait for it to reconnect, then try again.',
        );
      }
    }

    return {
      message: 'Batch spooling command emitted to daemon successfully.',
      spooledCount: payload.length,
    };
  }
}
