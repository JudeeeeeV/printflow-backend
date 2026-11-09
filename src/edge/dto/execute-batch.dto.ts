import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class ExecuteBatchDto {
  @IsOptional()
  @IsUUID('all')
  reviewToken?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @IsUUID('all', { each: true })
  orderIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  printerName?: string;

  /** Client-generated per reviewed batch; repeating it replays the outcome. */
  @IsOptional()
  @IsUUID('all')
  requestId?: string;
}

export class ManualProductionDto {
  @IsOptional()
  @IsUUID('all')
  reviewToken?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @IsUUID('all', { each: true })
  orderIds: string[];

  @IsOptional()
  @IsUUID('all')
  requestId?: string;
}
