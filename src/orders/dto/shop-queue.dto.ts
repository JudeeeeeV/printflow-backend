import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
} from 'class-validator';

export class ShopQueueQueryDto {
  @IsIn(['new', 'ready', 'pickup', 'history'])
  section: 'new' | 'ready' | 'pickup' | 'history' = 'new';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsIn(['ALL', 'SHORT', 'A4', 'LONG']) paperSize = 'ALL';
  @IsIn(['ALL', 'COLOR', 'BLACK_AND_WHITE']) colorMode = 'ALL';
  @IsIn(['ALL', 'GCASH', 'CASH_ON_PICKUP']) paymentMethod = 'ALL';
  @IsOptional() @IsString() @MaxLength(64) status?: string;
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @MaxLength(10)
  dateFrom?: string;
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @MaxLength(10)
  dateTo?: string;
  @IsIn(['default', 'oldest', 'newest', 'title', 'customer']) sort = 'default';
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(25) pageSize = 6;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  selectableOnly?: boolean;
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(25)
  @IsUUID('all', { each: true })
  excludeIds?: string[];
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(25)
  @IsUUID('all', { each: true })
  onlyIds?: string[];
}
