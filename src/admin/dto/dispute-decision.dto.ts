import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class DisputeDecisionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  receiptId: string;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
