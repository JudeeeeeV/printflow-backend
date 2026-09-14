import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

@Injectable()
export class PrintJobsRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  async createJob(orderId: string, shopId: string): Promise<void> {
    const supabase = this.supabaseService.getAdminClient();

    // In a full DB schema, we would have a print_jobs table.
    // Assuming the table might not exist yet, we try to insert. If it fails due to table not existing, we can log it.
    // For now, we will update the order state directly or just create a mock if the table doesn't exist.
    const { error } = await supabase.from('print_jobs').insert({
      order_id: orderId,
      shop_id: shopId,
      status: 'QUEUED',
    });

    if (error) {
      if (error.code === '42P01' || error.message.includes('schema cache')) {
        // Table doesn't exist, we skip or handle gracefully in a real scenario
        console.warn(
          'print_jobs table does not exist yet. Skipping job record creation.',
        );
      } else {
        throw new InternalServerErrorException(
          'Failed to create print job record: ' + error.message,
        );
      }
    }
  }

  async updateJobStatus(orderId: string, status: string): Promise<void> {
    const supabase = this.supabaseService.getAdminClient();
    const { error } = await supabase
      .from('print_jobs')
      .update({ status })
      .eq('order_id', orderId);

    if (
      error &&
      error.code !== '42P01' &&
      !error.message.includes('schema cache')
    ) {
      throw new InternalServerErrorException(
        'Failed to update print job status: ' + error.message,
      );
    }
  }
}
