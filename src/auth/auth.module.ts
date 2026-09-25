import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MicrosoftAuthController } from './microsoft-auth.controller';
import { MicrosoftAuthService } from './microsoft-auth.service';

@Module({
  controllers: [AuthController, MicrosoftAuthController],
  providers: [AuthService, MicrosoftAuthService],
  exports: [AuthService],
})
export class AuthModule {}
