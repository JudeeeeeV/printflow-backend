import { RegisterDto } from './register.dto';
import { IsEmail, IsString, Matches } from 'class-validator';

export class ResendEmailOtpDto {
  @IsEmail()
  email: string;
}

export class VerifyEmailOtpDto extends RegisterDto {
  @IsString()
  @Matches(/^[0-9]{8}$/, { message: 'Enter the 8-digit verification code' })
  code: string;
}
