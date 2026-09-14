import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SignupVerificationService } from './signup-verification.service';
import { PasswordResetService } from './password-reset.service';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SignupVerificationService, PasswordResetService],
})
export class AuthModule {}
