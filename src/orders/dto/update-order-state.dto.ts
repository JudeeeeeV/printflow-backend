import {
  Equals,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * READY_FOR_PICKUP records the operator's output inspection; COMPLETED records
 * customer handover. Both require the attempt the operator reviewed and an
 * explicit confirmation.
 */
export class UpdateOrderStateDto {
  @IsIn(['READY_FOR_PICKUP', 'COMPLETED'])
  state: 'READY_FOR_PICKUP' | 'COMPLETED';

  /** Null only for legacy orders that have no recorded attempt. */
  @IsOptional()
  @IsUUID('all')
  expectedAttemptId?: string | null;

  @IsBoolean()
  @Equals(true, { message: 'Explicit operator confirmation is required.' })
  confirmed: boolean;

  /** document, revision, paper, color, orientation, pages and copies. */
  @IsOptional()
  @IsObject()
  checks?: Record<string, unknown>;

  /** Required when no submission was reported for the inspected attempt. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reconciliationReason?: string;
}
