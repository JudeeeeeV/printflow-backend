import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';

export class UploadReceiptDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'A payment reference is required' })
  @MaxLength(120)
  referenceNumber: string;
}
