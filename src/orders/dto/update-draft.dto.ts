import {
  IsIn,
  IsOptional,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
} from 'class-validator';

export class UpdateDraftDto {
  @IsOptional()
  @IsIn(['GCASH', 'CASH_ON_PICKUP'])
  paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP';

  @IsUUID('all')
  shopId: string;

  @IsString()
  @IsNotEmpty()
  paperSize: string;

  @IsString()
  @IsNotEmpty()
  printColorMode: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(/\S/, { message: 'Order name cannot be blank' })
  orderName: string;

  @IsIn(['PORTRAIT', 'LANDSCAPE'])
  orientation: 'PORTRAIT' | 'LANDSCAPE';

  @IsInt()
  @Min(1)
  @Max(99)
  copies: number;
}
