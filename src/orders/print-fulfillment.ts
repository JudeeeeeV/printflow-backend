import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

/** Technical execution status of one print attempt. */
export type PrintAttemptStatus =
  | 'QUEUED'
  | 'RECEIVED'
  | 'DOWNLOADING'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'FAILED_PRE_SUBMISSION'
  | 'OUTCOME_UNKNOWN'
  | 'MANUAL_STARTED';

export const IN_FLIGHT_STATUSES: readonly string[] = [
  'QUEUED',
  'RECEIVED',
  'DOWNLOADING',
  'SUBMITTING',
];
export const AWAITING_OUTPUT_STATUSES: readonly string[] = [
  'SUBMITTED',
  'MANUAL_STARTED',
];

/** Ten minutes without progress is a reconciliation warning, never a failure. */
export const STALE_PROGRESS_MS = 10 * 60 * 1000;

/** Largest printable PDF the agent accepts; the server rejects larger files first. */
export const MAX_PRINTABLE_PDF_BYTES = 50 * 1024 * 1024;

/** Socket handshake capability required for new automated dispatches. */
export const AGENT_PROTOCOL_VERSION = 2;
export const AGENT_ATTEMPT_CAPABILITY = 'attempt-reporting-v1';

export const OUTPUT_CHECKS = [
  'document',
  'revision',
  'paper',
  'color',
  'orientation',
  'pages',
  'copies',
] as const;

export interface PrintAttemptRow {
  attempt_id: string;
  order_id: string;
  shop_id: string;
  status: string;
  attempt_number: number;
  attempt_kind: 'INITIAL' | 'RETRY' | 'REPRINT';
  execution_mode: 'AGENT' | 'MANUAL';
  previous_attempt_id: string | null;
  superseded_by_attempt_id: string | null;
  batch_request_id: string | null;
  revision_ref: string | null;
  device_id: string | null;
  printer_name: string | null;
  print_settings: Record<string, unknown> | null;
  printable_path: string | null;
  printable_sha256: string | null;
  printable_size: number | null;
  failure_phase: string | null;
  error_code: string | null;
  error_message: string | null;
  last_event_sequence: number;
  reason: string | null;
  authorized_at: string | null;
  received_at: string | null;
  submitted_at: string | null;
  agent_seen_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  is_legacy: boolean;
  legacy_status: string | null;
}

export const ATTEMPT_COLUMNS =
  'attempt_id, order_id, shop_id, status, attempt_number, attempt_kind, execution_mode, previous_attempt_id, superseded_by_attempt_id, batch_request_id, revision_ref, device_id, printer_name, print_settings, printable_path, printable_sha256, printable_size, failure_phase, error_code, error_message, last_event_sequence, reason, authorized_at, received_at, submitted_at, agent_seen_at, resolved_at, resolution, created_at, updated_at, is_legacy, legacy_status';

export function isStale(attempt: PrintAttemptRow, now = Date.now()) {
  if (attempt.resolved_at || !IN_FLIGHT_STATUSES.includes(attempt.status))
    return false;
  const lastProgress = Date.parse(attempt.updated_at);
  const lastSeen = attempt.agent_seen_at
    ? Date.parse(attempt.agent_seen_at)
    : lastProgress;
  // A job waiting behind other work is still reported by the agent heartbeat.
  return (
    now - Math.max(lastProgress, lastSeen) >= STALE_PROGRESS_MS &&
    now - lastProgress >= STALE_PROGRESS_MS
  );
}

/** Operator-facing attempt view: no storage paths or file identities. */
export function presentAttempt(attempt: PrintAttemptRow, now = Date.now()) {
  return {
    attemptId: attempt.attempt_id,
    orderId: attempt.order_id,
    attemptNumber: attempt.attempt_number,
    kind: attempt.attempt_kind,
    mode: attempt.execution_mode,
    status: attempt.status,
    deviceId: attempt.device_id,
    printerName: attempt.printer_name,
    previousAttemptId: attempt.previous_attempt_id,
    supersededByAttemptId: attempt.superseded_by_attempt_id,
    revisionId: attempt.revision_ref,
    failurePhase: attempt.failure_phase,
    errorCode: attempt.error_code,
    errorMessage: attempt.error_message,
    reason: attempt.reason,
    resolution: attempt.resolution,
    resolvedAt: attempt.resolved_at,
    receivedAt: attempt.received_at,
    submittedAt: attempt.submitted_at,
    createdAt: attempt.created_at,
    updatedAt: attempt.updated_at,
    isLegacy: attempt.is_legacy,
    isStale: isStale(attempt, now),
  };
}

export type PresentedAttempt = ReturnType<typeof presentAttempt>;

export type FulfillmentStage =
  | 'PREPARING'
  | 'PRINTING'
  | 'CHECKING_OUTPUT'
  | 'READY_FOR_PICKUP'
  | 'COMPLETED';

/**
 * Student-facing stage. Device errors, failures and uncertainty are never
 * exposed; they read as work still in progress at the shop.
 */
export function fulfillmentStage(
  orderState: string,
  attempt?: Pick<PrintAttemptRow, 'status' | 'resolved_at'> | null,
): FulfillmentStage | null {
  if (orderState === 'COMPLETED') return 'COMPLETED';
  if (orderState === 'READY_FOR_PICKUP') return 'READY_FOR_PICKUP';
  if (orderState === 'PRINTED') return 'CHECKING_OUTPUT';
  if (orderState !== 'IN_PRODUCTION') return null;
  if (!attempt || attempt.resolved_at) return 'PREPARING';
  if (AWAITING_OUTPUT_STATUSES.includes(attempt.status))
    return 'CHECKING_OUTPUT';
  return attempt.status === 'QUEUED' ? 'PREPARING' : 'PRINTING';
}

const CODE_ERRORS: Record<string, () => HttpException> = {
  ORDER_NOT_FOUND: () => new NotFoundException('Order not found.'),
  ATTEMPT_NOT_FOUND: () => new NotFoundException('Print attempt not found.'),
  INVALID_REQUEST: () =>
    new BadRequestException('The print request is invalid.'),
  ORDER_NOT_PRINTABLE: () =>
    new ConflictException(
      'This order is not awaiting production. Handed-over, cancelled, rejected and expired orders cannot be printed again.',
    ),
  ATTEMPT_OPEN: () =>
    new ConflictException(
      'This order already has an unresolved print attempt. Resolve it before sending another.',
    ),
  ATTEMPT_NOT_CURRENT: () =>
    new ConflictException(
      'This print attempt is no longer current. Refresh the queue and review the latest attempt.',
    ),
  ATTEMPT_NOT_RETRYABLE: () =>
    new ConflictException(
      'Only a failed attempt, or one whose outcome is uncertain or stalled, can be retried.',
    ),
  RECONCILIATION_REQUIRED: () =>
    new BadRequestException(
      'Inspect the printer and its queue, confirm the earlier submission is stopped or cleared, and give a reason before authorizing another attempt.',
    ),
  REASON_REQUIRED: () => new BadRequestException('A reason is required.'),
  ATTEMPT_NOT_REPRINTABLE: () =>
    new ConflictException(
      'A reprint is possible only after the current attempt was submitted or its output confirmed. Retry or resolve failed and uncertain attempts instead.',
    ),
  REVISION_CHANGED: () =>
    new ConflictException(
      'The approved file revision changed. The order must be reviewed again.',
    ),
  CHECKS_INCOMPLETE: () =>
    new BadRequestException(
      'Confirm every output check before marking the order ready.',
    ),
  RECONCILIATION_REASON_REQUIRED: () =>
    new BadRequestException(
      'No submission was reported for this attempt. Give a reconciliation reason after inspecting the output.',
    ),
  ATTEMPT_FAILED: () =>
    new ConflictException(
      'This attempt failed before submission. Retry it instead of confirming output.',
    ),
  ORDER_NOT_CONFIRMABLE: () =>
    new ConflictException('This order is not awaiting output confirmation.'),
  OUTPUT_NOT_CONFIRMED: () =>
    new ConflictException(
      'Confirm the printed output before recording handover.',
    ),
  PAYMENT_NOT_SETTLED: () =>
    new ConflictException('Payment must be recorded before handover.'),
};

export function fulfillmentError(code: unknown): HttpException {
  const factory = typeof code === 'string' ? CODE_ERRORS[code] : undefined;
  return factory
    ? factory()
    : new InternalServerErrorException(
        'The print action could not be recorded.',
      );
}

export interface RpcResult {
  ok?: boolean;
  code?: string;
  result?: string;
  [key: string]: unknown;
}
