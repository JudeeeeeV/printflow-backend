import { IsUrl, IsNotEmpty } from 'class-validator';

export class UploadReceiptDto {
  @IsUrl({}, { message: 'Receipt URL must be a valid URL' })
  @IsNotEmpty()
  receiptUrl: string;
}
