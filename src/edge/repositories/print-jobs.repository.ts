import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  ATTEMPT_COLUMNS,
  IN_FLIGHT_STATUSES,
  type PrintAttemptRow,
  type RpcResult,
} from '../../orders/print-fulfillment';

export interface CreateAttemptInput {
  orderId: string;
  shopId: string;
  kind: 'INITIAL' | 'RETRY' | 'REPRINT';
  mode: 'AGENT' | 'MANUAL';
  previousAttemptId: string | null;
  revisionId: string;
  printable: { path: string; sha256: string; size: number };
  deviceId: string | null;
  printerName: string | null;
  settings: Record<string, unknown>;
  batchRequestId: string | null;
  actorId: string;
  reason?: string | null;
  queueCleared?: boolean;
}

export interface AgentEventInput {
  attemptId: string;
  shopId: string;
  deviceId: string;
  sequence: number;
  status: string;
  failurePhase?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  occurredAt?: string | null;
}

/** Durable print attempts. Every state transition runs in a database function. */
@Injectable()
export class PrintJobsRepository {
  private readonly logger = new Logger(PrintJobsRepository.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  private async rpc<T = RpcResult>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response: {
      data: unknown;
      error: {
        code?: string;
        message?: string;
        details?: string;
        hint?: string;
      } | null;
    } = await this.supabaseService.getAdminClient().rpc(name, args);
    if (response.error) {
      // Server log only: the client receives a generic message.
      const { code, message, details, hint } = response.error;
      this.logger.error(
        `${name} failed [${code ?? 'unknown'}]: ${message ?? 'no message'}${details ? ` | details: ${details}` : ''}${hint ? ` | hint: ${hint}` : ''}`,
      );
      throw new InternalServerErrorException(
        'The print record could not be saved. Try again.',
      );
    }
    return response.data as T;
  }

  beginBatchRequest(
    requestId: string,
    shopId: string,
    requestHash: string,
    actorId: string,
  ) {
    return this.rpc<{
      state: 'NEW' | 'IN_PROGRESS' | 'CONFLICT' | 'DONE';
      status?: 'COMPLETED' | 'FAILED';
      response?: Record<string, unknown>;
    }>('print_begin_batch_request', {
      p_request_id: requestId,
      p_shop_id: shopId,
      p_request_hash: requestHash,
      p_actor_id: actorId,
    });
  }

  completeBatchRequest(
    requestId: string,
    shopId: string,
    status: 'COMPLETED' | 'FAILED',
    response: Record<string, unknown>,
  ) {
    return this.rpc<boolean>('print_complete_batch_request', {
      p_request_id: requestId,
      p_shop_id: shopId,
      p_status: status,
      p_response: response,
    });
  }

  createAttempt(input: CreateAttemptInput) {
    return this.rpc<RpcResult & { attempt?: PrintAttemptRow }>(
      'print_create_attempt',
      {
        p_order_id: input.orderId,
        p_shop_id: input.shopId,
        p_kind: input.kind,
        p_mode: input.mode,
        p_previous_attempt_id: input.previousAttemptId,
        p_revision_id: input.revisionId,
        p_printable_path: input.printable.path,
        p_printable_sha256: input.printable.sha256,
        p_printable_size: input.printable.size,
        p_device_id: input.deviceId,
        p_printer_name: input.printerName,
        p_print_settings: input.settings,
        p_batch_request_id: input.batchRequestId,
        p_actor_id: input.actorId,
        p_reason: input.reason ?? null,
        p_queue_cleared: input.queueCleared ?? false,
      },
    );
  }

  recordAgentEvent(input: AgentEventInput) {
    return this.rpc<RpcResult & { attempt?: PrintAttemptRow; retry?: boolean }>(
      'print_record_agent_event',
      {
        p_attempt_id: input.attemptId,
        p_shop_id: input.shopId,
        p_device_id: input.deviceId,
        p_sequence: input.sequence,
        p_status: input.status,
        p_failure_phase: input.failurePhase ?? null,
        p_error_code: input.errorCode ?? null,
        p_error_message: input.errorMessage ?? null,
        p_occurred_at: input.occurredAt ?? null,
      },
    );
  }

  authorizeAttempt(attemptId: string, shopId: string, deviceId: string) {
    return this.rpc<{
      authorized: boolean;
      reason?: string;
      blockingAttemptId?: string;
    }>('print_authorize_attempt', {
      p_attempt_id: attemptId,
      p_shop_id: shopId,
      p_device_id: deviceId,
    });
  }

  markUndelivered(
    attemptIds: string[],
    shopId: string,
    errorCode: string,
    errorMessage: string,
  ) {
    return this.rpc<number>('print_mark_undelivered', {
      p_attempt_ids: attemptIds,
      p_shop_id: shopId,
      p_error_code: errorCode,
      p_error_message: errorMessage,
    });
  }

  recordReconciliationNote(
    attemptId: string,
    shopId: string,
    actorId: string,
    reason: string,
  ) {
    return this.rpc('print_record_reconciliation_note', {
      p_attempt_id: attemptId,
      p_shop_id: shopId,
      p_actor_id: actorId,
      p_reason: reason,
    });
  }

  async findAttempt(attemptId: string, shopId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('print_jobs')
      .select(ATTEMPT_COLUMNS)
      .eq('attempt_id', attemptId)
      .eq('shop_id', shopId)
      .maybeSingle();
    if (error)
      throw new InternalServerErrorException('Failed to load print attempt');
    const row: unknown = data;
    return (row as PrintAttemptRow | null) ?? null;
  }

  async findAttempts(attemptIds: string[], shopId: string) {
    if (attemptIds.length === 0) return [];
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('print_jobs')
      .select(ATTEMPT_COLUMNS)
      .eq('shop_id', shopId)
      .in('attempt_id', attemptIds);
    if (error)
      throw new InternalServerErrorException('Failed to load print attempts');
    return (data || []) as unknown as PrintAttemptRow[];
  }

  async findOpenAttempts(shopId: string, orderIds: string[]) {
    if (orderIds.length === 0) return [];
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('print_jobs')
      .select(ATTEMPT_COLUMNS)
      .eq('shop_id', shopId)
      .in('order_id', orderIds)
      .is('resolved_at', null);
    if (error)
      throw new InternalServerErrorException('Failed to load print attempts');
    return (data || []) as unknown as PrintAttemptRow[];
  }

  /** Open automated attempts this device has not started printing. */
  async findRedeliverable(deviceId: string, shopId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('print_jobs')
      .select(ATTEMPT_COLUMNS)
      .eq('shop_id', shopId)
      .eq('device_id', deviceId)
      .eq('execution_mode', 'AGENT')
      .is('resolved_at', null)
      .in('status', ['QUEUED', 'RECEIVED', 'DOWNLOADING'])
      .order('created_at', { ascending: true })
      .limit(100);
    if (error)
      throw new InternalServerErrorException('Failed to load pending attempts');
    return (data || []) as unknown as PrintAttemptRow[];
  }

  /** Heartbeat evidence that queued work is waiting, not failed. */
  async touchWaitingAttempts(
    deviceId: string,
    shopId: string,
    attemptIds: string[],
  ) {
    if (attemptIds.length === 0) return;
    await this.supabaseService
      .getAdminClient()
      .from('print_jobs')
      .update({ agent_seen_at: new Date().toISOString() })
      .eq('shop_id', shopId)
      .eq('device_id', deviceId)
      .is('resolved_at', null)
      .in('status', [...IN_FLIGHT_STATUSES])
      .in('attempt_id', attemptIds);
  }

  async history(shopId: string, orderId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const [attempts, events, fulfillment] = await Promise.all([
      supabase
        .from('print_jobs')
        .select(ATTEMPT_COLUMNS)
        .eq('shop_id', shopId)
        .eq('order_id', orderId)
        .order('attempt_number', { ascending: true }),
      supabase
        .from('print_job_events')
        .select(
          'id, attempt_id, source, event_type, status, agent_sequence, device_id, actor_id, outcome, details, occurred_at, created_at',
        )
        .eq('shop_id', shopId)
        .eq('order_id', orderId)
        .order('id', { ascending: true })
        .limit(500),
      supabase
        .from('order_fulfillment_events')
        .select(
          'id, event_type, attempt_id, revision_id, actor_id, reason, details, created_at',
        )
        .eq('shop_id', shopId)
        .eq('order_id', orderId)
        .order('id', { ascending: true }),
    ]);
    if (attempts.error || events.error || fulfillment.error)
      throw new InternalServerErrorException('Failed to load print history');
    return {
      attempts: (attempts.data || []) as unknown as PrintAttemptRow[],
      events: events.data || [],
      fulfillment: fulfillment.data || [],
    };
  }
}
