import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MicrosoftAuthController } from './microsoft-auth.controller';
import { MicrosoftAuthService } from './microsoft-auth.service';
import { TurnstileService } from './turnstile.service';

@Module({
  controllers: [AuthController, MicrosoftAuthController],
  providers: [AuthService, MicrosoftAuthService, TurnstileService],
  exports: [AuthService],
})
export class AuthModule {}
