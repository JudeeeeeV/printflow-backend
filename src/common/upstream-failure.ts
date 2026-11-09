import { ServiceUnavailableException } from '@nestjs/common';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';

// PGRST116: .single() matched no row. 22P02: the id is not a valid UUID.
const MISSING_ROW_CODES = new Set(['PGRST116', '22P02']);

/** A failed read is not proof that the row is missing. */
export function throwIfReadFailed(
  error: { code?: string } | null | undefined,
): void {
  if (error && !MISSING_ROW_CODES.has(error.code ?? '')) {
    throw new ServiceUnavailableException(
      'This information is temporarily unavailable. Please try again.',
    );
  }
}

/** True when Supabase Auth could not answer, rather than rejecting the token. */
export function isTemporaryAuthFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}
