import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendPasswordResetDto, ResetPasswordDto } from './dto/password-reset.dto';

import { ResendEmailOtpDto, VerifyEmailOtpDto } from './dto/email-otp.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailOtpDto) {
    return this.authService.verifyEmail(dto);
  }

  @Post('resend-code')
  resendCode(@Body() dto: ResendEmailOtpDto) {
    return this.authService.resendCode(dto);
  }

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('forgot-password/send')
  async sendPasswordReset(@Body() dto: SendPasswordResetDto) {
    return this.authService.sendPasswordReset(dto.email);
  }

  @Post('forgot-password/reset')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }
}