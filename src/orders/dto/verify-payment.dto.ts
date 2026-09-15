import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class VerifyPaymentDto {
  @IsIn(['APPROVE', 'REJECT'])
  action: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
