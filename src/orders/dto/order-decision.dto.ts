import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class OrderDecisionDto {
  @IsIn([
    'ACCEPT',
    'REJECT_ORDER',
    'COLLECT_CASH',
    'RECORD_REFUND',
    'FLAG_UNCLAIMED',
    'CLEAR_UNCLAIMED',
  ])
  action:
    | 'ACCEPT'
    | 'REJECT_ORDER'
    | 'COLLECT_CASH'
    | 'RECORD_REFUND'
    | 'FLAG_UNCLAIMED'
    | 'CLEAR_UNCLAIMED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class DraftPaymentDto {
  @IsOptional()
  @IsIn(['GCASH', 'CASH_ON_PICKUP'])
  paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP';
}

export class PaymentDisputeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
