import { IsString, IsUrl, IsNotEmpty, IsUUID } from 'class-validator';

export class CreateOrderDto {
  @IsUUID("all", { message: 'Invalid Shop ID format' })
  @IsNotEmpty()
  shopId: string;

}