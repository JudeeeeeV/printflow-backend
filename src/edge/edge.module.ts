import { Module } from '@nestjs/common';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintSpoolerService } from './print-spooler.service';
import { EdgeController } from './edge.controller';
import { AssetUrlSigningService } from './services/asset-url-signing.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [EdgeController],
  providers: [
    EdgeDaemonGateway,
    PrintSpoolerService,
    AssetUrlSigningService,
    PrintJobsRepository,
  ],
  exports: [EdgeDaemonGateway],
})
export class EdgeModule {}
