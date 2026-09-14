import { IsString, IsNotEmpty, IsUUID, IsOptional } from 'class-validator';

export class CreateOrderDto {
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
}
