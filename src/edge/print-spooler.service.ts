import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { AssetUrlSigningService } from './services/asset-url-signing.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class PrintSpoolerService {
  private readonly logger = new Logger(PrintSpoolerService.name);

  constructor(
    private readonly gateway: EdgeDaemonGateway,
    private readonly urlSigner: AssetUrlSigningService,
    private readonly printJobsRepo: PrintJobsRepository,
    private readonly supabaseService: SupabaseService,
  ) {}

  async executeBatch(orderIds: string[], shopId: string, printerName?: string) {
    const supabase = this.supabaseService.getAdminClient();

    // Validate that orders are IN_PRODUCTION and belong to this shop
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, state, print_color_mode, assets(file_url)')
      .eq('shop_id', shopId)
      .in('id', orderIds);

    if (error || !orders) {
      throw new InternalServerErrorException('Failed to validate orders for batch printing');
    }

    const validOrders = orders.filter(o => o.state === 'IN_PRODUCTION');
    if (validOrders.length === 0) {
      throw new NotFoundException('No valid IN_PRODUCTION orders found for this batch');
    }

    const payload = [];

    for (const order of validOrders) {
      const assetUrl = order.assets && order.assets.length > 0 ? order.assets[0].file_url : null;
      if (!assetUrl) {
        this.logger.warn(`Order ${order.id} has no asset URL, skipping.`);
        continue;
      }

      const signedUrl = this.urlSigner.signUrl(assetUrl, 3600); // 1 hour expiry
      
      await this.printJobsRepo.createJob(order.id, shopId);
      
      payload.push({
        id: order.id,
        file_url: signedUrl,
        print_color_mode: order.print_color_mode
      });
    }

    if (payload.length > 0) {
      this.logger.log(`Emitting batch_execute for ${payload.length} orders to shop ${shopId} using printer ${printerName || 'default'}`);
      this.gateway.emitBatchExecute(shopId, { orders: payload, printerName });
    }
    
    return {
      message: 'Batch spooling command emitted to daemon successfully.',
      spooledCount: payload.length
    };
  }

  async handleDaemonAck(orderId: string, status: string) {
    this.logger.log(`Received daemon ack for order ${orderId} with status ${status}`);
    await this.printJobsRepo.updateJobStatus(orderId, status);
    
    if (status === 'SUCCESS' || status === 'COMPLETED') {
      const supabase = this.supabaseService.getAdminClient();
      await supabase
        .from('orders')
        .update({ state: 'PRINTED' }) // or COMPLETED based on your state machine
        .eq('id', orderId);
    }
  }
}
