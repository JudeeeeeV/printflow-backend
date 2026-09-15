import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

@Injectable()
export class PrintJobsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async claimJob(orderId: string, shopId: string): Promise<boolean> {
    const supabase = this.supabaseService.getAdminClient();
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { error: staleError } = await supabase
      .from('print_jobs')
      .update({ status: 'FAILED', updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('shop_id', shopId)
      .in('status', ['QUEUED', 'DOWNLOADING', 'SENT_TO_SPOOLER'])
      .lt('updated_at', staleBefore);
    if (staleError) {
      throw new InternalServerErrorException(
        'Failed to inspect existing print job: ' + staleError.message,
      );
    }

    const { error } = await supabase.from('print_jobs').insert({
      order_id: orderId,
      shop_id: shopId,
      status: 'QUEUED',
    });

    if (error) {
      if (error.code === '23505') return false;
      throw new InternalServerErrorException(
        'Failed to claim print job: ' + error.message,
      );
    }
    return true;
  }

  async updateJobStatus(
    orderId: string,
    shopId: string,
    status: string,
  ): Promise<void> {
    const supabase = this.supabaseService.getAdminClient();
    const { error } = await supabase
      .from('print_jobs')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('order_id', orderId)
      .eq('shop_id', shopId)
      .neq('status', 'FAILED');

    if (error) {
      throw new InternalServerErrorException(
        'Failed to update print job status: ' + error.message,
      );
    }
  }
}
