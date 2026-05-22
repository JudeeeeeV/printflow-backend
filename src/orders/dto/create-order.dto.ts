import { IsString, IsUrl, IsNotEmpty, IsUUID } from 'class-validator';

export class CreateOrderDto {
  @IsUUID(4, { message: 'Invalid Shop ID format' })
  @IsNotEmpty()
  shopId: string;

  @IsUrl({}, { message: 'Asset URL must be a valid URL' })
  @IsNotEmpty()
  assetUrl: string;
}