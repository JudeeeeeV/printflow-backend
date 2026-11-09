import { Module } from '@nestjs/common';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintSpoolerService } from './print-spooler.service';
import { EdgeController } from './edge.controller';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseModule } from '../supabase/supabase.module';
import { DaemonDevicesModule } from '../daemon-devices/daemon-devices.module';
import { OrdersModule } from '../orders/orders.module';
import { PrintAssetService } from './print-asset.service';
import { ReviewedBatchService } from './reviewed-batch.service';

@Module({
  imports: [SupabaseModule, DaemonDevicesModule, OrdersModule],
  controllers: [EdgeController],
  providers: [
    EdgeDaemonGateway,
    PrintSpoolerService,
    PrintJobsRepository,
    PrintAssetService,
    ReviewedBatchService,
  ],
  exports: [EdgeDaemonGateway],
})
export class EdgeModule {}
