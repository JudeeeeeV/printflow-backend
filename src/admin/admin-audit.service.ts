import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async record(event: {
    actorId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    outcome: 'SUCCESS' | 'FAILURE';
    requestId: string;
    sourceIp?: string;
  }): Promise<void> {
    try {
      const { error } = await this.supabase
        .getAdminClient()
        .from('admin_audit_events')
        .insert({
          actor_id: event.actorId,
          action: event.action.slice(0, 160),
          target_type: event.targetType?.slice(0, 80) || null,
          target_id: event.targetId?.slice(0, 200) || null,
          outcome: event.outcome,
          request_id: event.requestId,
          source_ip: event.sourceIp?.slice(0, 80) || null,
        });
      if (error) this.logger.error('Failed to write an admin audit event');
    } catch {
      this.logger.error('Failed to write an admin audit event');
    }
  }
}
