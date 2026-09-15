import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class VerifyShopDto {
  @IsIn(['VERIFIED', 'REJECTED'])
  status: 'VERIFIED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
