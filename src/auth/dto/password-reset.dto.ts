import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class SendPasswordResetDto {
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @MinLength(8)
  password: string;
}
