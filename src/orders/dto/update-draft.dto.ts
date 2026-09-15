import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class UpdateDraftDto {
  @IsUUID('all')
  shopId: string;

  @IsString()
  @IsNotEmpty()
  paperSize: string;

  @IsString()
  @IsNotEmpty()
  printColorMode: string;
}
