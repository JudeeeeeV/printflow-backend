import {
  Equals,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RetryAttemptDto {
  @IsIn(['AGENT', 'MANUAL'])
  mode: 'AGENT' | 'MANUAL';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  printerName?: string;

  /** Required by the server for uncertain or stalled attempts. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** The operator confirmed the earlier submission is stopped or cleared. */
  @IsOptional()
  @IsBoolean()
  queueCleared?: boolean;
}

export class ReprintOrderDto {
  /** The attempt the operator reviewed; null only for legacy orders. */
  @IsOptional()
  @IsUUID('all')
  expectedAttemptId?: string | null;

  @IsIn(['AGENT', 'MANUAL'])
  mode: 'AGENT' | 'MANUAL';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  printerName?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @IsBoolean()
  @Equals(true, {
    message:
      'Confirm that the entire approved job, including every copy, will be printed again.',
  })
  confirmFullJob: boolean;
}

export class ReconciliationNoteDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
