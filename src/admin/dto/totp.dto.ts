import { IsString, Matches } from 'class-validator';

export class TotpDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP token must contain exactly 6 digits' })
  token: string;
}
