import { Transform } from 'class-transformer';
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
  ValidateIf,
} from 'class-validator';

// These bodies arrive as JSON or, with a replacement file, as multipart text.
const toOptionalNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? undefined : Number(value);

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

  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  @Max(99)
  copies: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

const hasSettings = (body: SubmitDraftDto) => body.shopId !== undefined;

/** Settings are all-or-nothing; without them the saved draft is submitted as is. */
export class SubmitDraftDto {
  @IsOptional()
  @IsIn(['GCASH', 'CASH_ON_PICKUP'])
  paymentMethod?: 'GCASH' | 'CASH_ON_PICKUP';

  @IsOptional()
  @IsUUID('all')
  shopId?: string;

  @ValidateIf(hasSettings)
  @IsString()
  @IsNotEmpty()
  paperSize?: string;

  @ValidateIf(hasSettings)
  @IsString()
  @IsNotEmpty()
  printColorMode?: string;

  @ValidateIf(hasSettings)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Matches(/\S/, { message: 'Order name cannot be blank' })
  orderName?: string;

  @ValidateIf(hasSettings)
  @IsIn(['PORTRAIT', 'LANDSCAPE'])
  orientation?: 'PORTRAIT' | 'LANDSCAPE';

  @ValidateIf(hasSettings)
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(1)
  @Max(99)
  copies?: number;

  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
