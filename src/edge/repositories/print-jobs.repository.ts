import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { throwPaymentError } from '../../orders/payment-workflow';

@Injectable()
export class PrintJobsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async claimJob(orderId: string, shopId: string): Promise<boolean> {
    const result = await this.supabaseService
      .getAdminClient()
      .rpc('claim_payment_eligible_print_job', {
        p_order: orderId,
        p_shop: shopId,
      });
    if (result.error) throwPaymentError(result.error);
    return result.data === true;
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
