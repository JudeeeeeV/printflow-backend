import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class VerifyPaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  receiptId: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;

  @IsIn(['APPROVE', 'REJECT'])
  action: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
