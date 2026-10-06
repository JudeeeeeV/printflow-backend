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
import { PrintAssetService } from './print-asset.service';

interface PrintOrder {
  id: string;
  state: string;
  print_color_mode: string;
  paper_size: string;
  orientation: 'PORTRAIT' | 'LANDSCAPE';
  copies: number;
  assets: Array<{ file_url: string }>;
}

@Injectable()
export class PrintSpoolerService {
  private readonly logger = new Logger(PrintSpoolerService.name);

  constructor(
    private readonly gateway: EdgeDaemonGateway,
    private readonly printJobsRepo: PrintJobsRepository,
    private readonly supabaseService: SupabaseService,
    private readonly printAssets: PrintAssetService,
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
      .select(
        'id, state, print_color_mode, paper_size, orientation, copies, assets(file_url)',
      )
      .eq('shop_id', shopId)
      .in('id', orderIds);

    if (error || !orders) {
      throw new InternalServerErrorException(
        'Failed to validate orders for batch printing',
      );
    }

    const orderRows = orders as unknown as PrintOrder[];
    const validOrders = orderRows.filter(
      (order) => order.state === 'IN_PRODUCTION',
    );
    if (validOrders.length === 0) {
      throw new NotFoundException(
        'No valid IN_PRODUCTION orders found for this batch',
      );
    }

    const prepared: Array<{
      id: string;
      file_url: string;
      print_color_mode: string;
      orientation: 'PORTRAIT' | 'LANDSCAPE';
      copies: number;
      paper_size: string;
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

      const signedUrl = await this.printAssets.prepare(
        assetUrl,
        shopId,
        order.id,
        order.paper_size,
      );

      prepared.push({
        id: order.id,
        file_url: signedUrl,
        print_color_mode: order.print_color_mode,
        orientation: order.orientation,
        copies: order.copies,
        paper_size: order.paper_size,
      });
    }

    // Prepare every file before claiming jobs so a conversion failure cannot
    // leave earlier orders queued without ever dispatching them.
    const payload: typeof prepared = [];
    for (const order of prepared) {
      if (await this.printJobsRepo.claimJob(order.id, shopId)) {
        payload.push(order);
      }
    }
    if (payload.length === 0) {
      throw new ConflictException(
        'No printable orders are available, or the selected orders already have active print jobs.',
      );
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
