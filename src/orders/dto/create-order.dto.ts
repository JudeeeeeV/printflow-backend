import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  Max,
  MaxLength,
  Matches,
  Min,
} from 'class-validator';

export class CreateOrderDto {
  @IsOptional()
  @IsIn(['GCASH', 'CASH_ON_PICKUP'])
  paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP';

  @IsUUID('all', { message: 'Invalid Shop ID format' })
  @IsNotEmpty()
  shopId: string;

  @IsOptional()
  @IsString()
  isDraft?: string;

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

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(99)
  copies: number;
}
