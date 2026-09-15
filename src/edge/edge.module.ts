import { Module } from '@nestjs/common';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { PrintSpoolerService } from './print-spooler.service';
import { EdgeController } from './edge.controller';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [EdgeController],
  providers: [EdgeDaemonGateway, PrintSpoolerService, PrintJobsRepository],
  exports: [EdgeDaemonGateway],
})
export class EdgeModule {}
