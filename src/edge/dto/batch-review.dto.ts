import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ReviewSelectionDto {
  @IsUUID('all') orderId: string;
  @Matches(/^[a-f0-9]{32}$/) fingerprint: string;
}

export class BatchPreviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ArrayUnique((item: ReviewSelectionDto | null) => item?.orderId)
  @ValidateNested({ each: true })
  @Type(() => ReviewSelectionDto)
  orders: ReviewSelectionDto[];
  @IsIn(['AGENT', 'MANUAL']) mode: 'AGENT' | 'MANUAL';
  @IsOptional() @IsString() @MaxLength(200) printerName?: string;
}
