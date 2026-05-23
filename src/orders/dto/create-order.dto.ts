import { IsString, IsUrl, IsNotEmpty, IsUUID } from 'class-validator';
import { IsBoolean, IsOptional } from 'class-validator';

export class CreateOrderDto {
  @IsUUID("all", { message: 'Invalid Shop ID format' })
  @IsNotEmpty()
  shopId: string;

  @IsOptional()
    @IsString()
    isDraft?: string;
}