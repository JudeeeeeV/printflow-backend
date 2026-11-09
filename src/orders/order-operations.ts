import {
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PostgrestSingleResponse } from '@supabase/supabase-js';
import { OrderDecisionUnavailableException } from '../common/order-decision-unavailable.exception';
import { throwIfReadFailed } from '../common/upstream-failure';
import { SupabaseService } from '../supabase/supabase.service';
import { throwPaymentError } from './payment-workflow';

export const OPERATION_LEASE_SECONDS = 180;
const LEASE_RENEWAL_MS = 60_000;
const COMMIT_TIMEOUT_MS = 15_000;
const ORPHAN_GRACE_MS = 60 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const SWEEP_BATCH = 100;

export type OperationAction =
  | 'CREATE_ORDER'
  | 'CREATE_DRAFT'
  | 'UPDATE_DRAFT'
  | 'SUBMIT_DRAFT'
  | 'UPLOAD_RECEIPT';

export interface OperationRequest {
  userId: string;
  key: string;
  action: OperationAction;
  targetId: string | null;
  fingerprint: string;
  contentHash?: string | null;
}

export interface OperationClaim {
  key: string;
  generation: number;
  plannedOrderId: string;
  /** Records the object before upload so a crash cannot strand it. */
  stage(bucket: string, path: string): Promise<void>;
  commit<T>(
    data: Record<string, unknown>,
  ): Promise<{ result: T; replacedPaths: string[] }>;
}

interface ClaimResult {
  outcome: 'claimed' | 'succeeded' | 'processing' | 'conflict' | 'failed';
  generation?: number;
  plannedOrderId?: string;
  result?: unknown;
  retryAfterSeconds?: number;
  errorStatus?: number;
  errorBody?: Record<string, unknown>;
}

interface OperationRow {
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  generation: number;
  lease_expires_at: string;
  result: unknown;
  error_status: number | null;
  error_body: Record<string, unknown> | null;
  retryable: boolean;
}

/** 202 is carried by the exception filter so services can stop at any depth. */
export class OperationInProgressException extends HttpException {
  constructor(operationKey: string, retryAfterSeconds: number) {
    super(
      { status: 'processing', operationKey, retryAfterSeconds },
      HttpStatus.ACCEPTED,
    );
  }
}

class OperationClaimLostException extends ServiceUnavailableException {
  constructor() {
    super('This submission is still being confirmed.');
  }
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function operationFingerprint(inputs: Record<string, unknown>): string {
  return sha256(JSON.stringify(canonicalize(inputs)));
}

export class OrderOperations {
  private readonly logger = new Logger(OrderOperations.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  private get client() {
    return this.supabaseService.getAdminClient();
  }

  /**
   * Runs `work` at most once per key. The key is checked before any business
   * rule, so replaying a committed action returns its original result even
   * after the order has moved on, the shop has closed, or a deadline passed.
   */
  async run<T>(
    request: OperationRequest,
    work: (claim: OperationClaim) => Promise<T>,
  ): Promise<T> {
    const claimed = await this.claim(request);
    if (claimed.outcome === 'succeeded') return claimed.result as T;
    if (claimed.outcome === 'processing')
      throw new OperationInProgressException(
        request.key,
        claimed.retryAfterSeconds ?? 1,
      );
    if (claimed.outcome === 'conflict')
      throw new ConflictException({
        code: 'OPERATION_KEY_REUSED',
        message:
          'This submission changed while an earlier attempt was unresolved. Start it again.',
      });
    if (claimed.outcome === 'failed')
      throw new HttpException(
        claimed.errorBody ?? { message: 'This submission was not accepted.' },
        claimed.errorStatus ?? HttpStatus.CONFLICT,
      );

    const generation = claimed.generation as number;
    let commitAttempted = false;
    const renewal = setInterval(
      () => void this.renew(request, generation),
      LEASE_RENEWAL_MS,
    );
    renewal.unref?.();
    const handle: OperationClaim = {
      key: request.key,
      generation,
      plannedOrderId: claimed.plannedOrderId as string,
      stage: (bucket, path) => this.stage(request, generation, bucket, path),
      commit: <R>(data: Record<string, unknown>) => {
        commitAttempted = true;
        return this.commit<R>(request, generation, data);
      },
    };

    try {
      return await work(handle);
    } catch (error) {
      if (commitAttempted && isUncertainCommit(error)) {
        // The commit may have landed. Never report it as failed from here.
        const row = await this.read(request.userId, request.key).catch(
          () => null,
        );
        if (row?.status === 'SUCCEEDED') return row.result as T;
        throw error;
      }
      await this.recordFailure(request, generation, error);
      throw error;
    } finally {
      clearInterval(renewal);
    }
  }

  async status(userId: string, key: string) {
    const row = await this.read(userId, key);
    if (!row) return { status: 'unknown', retryAllowed: true };
    if (row.status === 'SUCCEEDED')
      return { status: 'succeeded', retryAllowed: false, result: row.result };
    if (row.status === 'FAILED')
      return {
        status: 'failed',
        retryAllowed: row.retryable,
        error: { status: row.error_status, data: row.error_body },
      };
    const remainingMs = new Date(row.lease_expires_at).getTime() - Date.now();
    return remainingMs > 0
      ? {
          status: 'processing',
          retryAllowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
        }
      : { status: 'processing', retryAllowed: true };
  }

  /** Finds an active order from a recent submission of the same file to the same shop. */
  async findRecentDuplicate(
    request: OperationRequest,
    windowMs: number,
  ): Promise<string | null> {
    const { data, error } = await this.client
      .from('order_operations')
      .select('result')
      .eq('user_id', request.userId)
      .eq('action', request.action)
      .eq('target_id', request.targetId as string)
      .eq('content_hash', request.contentHash as string)
      .eq('status', 'SUCCEEDED')
      .neq('operation_key', request.key)
      .gte('created_at', new Date(Date.now() - windowMs).toISOString())
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    const orderId = (data[0] as { result?: { orderId?: string } }).result
      ?.orderId;
    if (!orderId) return null;
    const { data: order } = await this.client
      .from('orders')
      .select('state')
      .eq('id', orderId)
      .eq('client_id', request.userId)
      .maybeSingle<{ state: string }>();
    return order && !['CANCELLED', 'REJECTED', 'EXPIRED'].includes(order.state)
      ? orderId
      : null;
  }

  /** Removes files stranded by crashes, then operation rows past retention. */
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
    const { data, error } = await this.client
      .from('order_operations')
      .select('user_id, operation_key, generation, staged_bucket, staged_path')
      .not('staged_path', 'is', null)
      .in('status', ['PROCESSING', 'FAILED'])
      .lt('lease_expires_at', cutoff)
      .limit(SWEEP_BATCH);
    if (error) {
      this.logger.error('Failed to inspect stranded submission files.');
      return;
    }
    for (const row of (data || []) as Array<{
      user_id: string;
      operation_key: string;
      generation: number;
      staged_bucket: string;
      staged_path: string;
    }>) {
      await this.removeStaged(
        row.user_id,
        row.operation_key,
        row.generation,
        row.staged_bucket,
        row.staged_path,
      );
    }
    const { error: retentionError } = await this.client
      .from('order_operations')
      .delete()
      .lt('created_at', new Date(Date.now() - RETENTION_MS).toISOString())
      .is('staged_path', null);
    if (retentionError) this.logger.error('Failed to remove old submissions.');
  }

  private async claim(request: OperationRequest): Promise<ClaimResult> {
    const { data, error } = (await this.client.rpc('claim_order_operation', {
      p_user: request.userId,
      p_key: request.key,
      p_action: request.action,
      p_target: request.targetId,
      p_fingerprint: request.fingerprint,
      p_content_hash: request.contentHash ?? null,
      p_lease_seconds: OPERATION_LEASE_SECONDS,
    })) as { data: ClaimResult | null; error: unknown };
    if (error || !data) {
      throw new ServiceUnavailableException(
        'Submissions are temporarily unavailable. Please try again.',
      );
    }
    return data;
  }

  private async commit<T>(
    request: OperationRequest,
    generation: number,
    data: Record<string, unknown>,
  ): Promise<{ result: T; replacedPaths: string[] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMMIT_TIMEOUT_MS);
    let response: PostgrestSingleResponse<unknown>;
    try {
      response = await this.client
        .rpc('commit_order_operation', {
          p_user: request.userId,
          p_key: request.key,
          p_generation: generation,
          p_data: data,
        })
        .abortSignal(controller.signal);
    } catch {
      throw new OrderDecisionUnavailableException();
    } finally {
      clearTimeout(timeout);
    }
    if (response.error) {
      if (response.error.code === 'PF001')
        throw new OperationClaimLostException();
      if (response.error.code === 'PF002')
        throw new ConflictException('Order is not a draft.');
      if (response.error.code === 'PF003')
        throw new ConflictException({
          code: 'DRAFT_VERSION_CONFLICT',
          message:
            'This draft changed while you were editing. Reload it and try again.',
        });
      throwPaymentError(response.error, {
        httpStatus: response.status,
        timedOut: controller.signal.aborted,
      });
    }
    if (!response.data || typeof response.data !== 'object') {
      throw new InternalServerErrorException(
        'The submission returned no result.',
      );
    }
    return response.data as { result: T; replacedPaths: string[] };
  }

  private async read(
    userId: string,
    key: string,
  ): Promise<OperationRow | null> {
    const { data, error } = await this.client
      .from('order_operations')
      .select(
        'status, generation, lease_expires_at, result, error_status, error_body, retryable',
      )
      .eq('user_id', userId)
      .eq('operation_key', key)
      .maybeSingle<OperationRow>();
    throwIfReadFailed(error);
    return data ?? null;
  }

  private current(request: OperationRequest, generation: number) {
    return {
      user_id: request.userId,
      operation_key: request.key,
      generation,
      status: 'PROCESSING',
    };
  }

  private async renew(request: OperationRequest, generation: number) {
    const { error } = await this.client
      .from('order_operations')
      .update({
        lease_expires_at: new Date(
          Date.now() + OPERATION_LEASE_SECONDS * 1000,
        ).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .match(this.current(request, generation));
    if (error) this.logger.warn('Could not renew a submission lease.');
  }

  private async stage(
    request: OperationRequest,
    generation: number,
    bucket: string,
    path: string,
  ) {
    const { error } = await this.client
      .from('order_operations')
      .update({ staged_bucket: bucket, staged_path: path })
      .match(this.current(request, generation));
    if (error) {
      throw new ServiceUnavailableException(
        'Submissions are temporarily unavailable. Please try again.',
      );
    }
  }

  private async recordFailure(
    request: OperationRequest,
    generation: number,
    error: unknown,
  ) {
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const retryable = status >= 500 || status === 429;
    const response = error instanceof HttpException ? error.getResponse() : '';
    const body =
      typeof response === 'string' ? { message: response } : response;
    const { data, error: updateError } = await this.client
      .from('order_operations')
      .update({
        status: 'FAILED',
        retryable,
        error_status: status,
        // Bodies below 500 were written for students; others stay private.
        error_body: status < 500 ? body : null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .match(this.current(request, generation))
      .select('staged_bucket, staged_path')
      .maybeSingle<{
        staged_bucket: string | null;
        staged_path: string | null;
      }>();
    if (updateError) {
      this.logger.warn('Could not record a failed submission.');
      return;
    }
    if (data?.staged_bucket && data.staged_path) {
      await this.removeStaged(
        request.userId,
        request.key,
        generation,
        data.staged_bucket,
        data.staged_path,
      );
    }
  }

  /** Clears the record only after storage confirms the object is gone. */
  private async removeStaged(
    userId: string,
    key: string,
    generation: number,
    bucket: string,
    path: string,
  ) {
    try {
      const { error } = await this.client.storage.from(bucket).remove([path]);
      if (error) throw error;
      await this.client
        .from('order_operations')
        .update({ staged_bucket: null, staged_path: null })
        .match({ user_id: userId, operation_key: key, generation });
    } catch {
      this.logger.warn('Could not remove a stranded submission file.');
    }
  }
}

function isUncertainCommit(error: unknown): boolean {
  return (
    error instanceof OrderDecisionUnavailableException ||
    error instanceof OperationClaimLostException ||
    !(error instanceof HttpException) ||
    error.getStatus() >= 500
  );
}
