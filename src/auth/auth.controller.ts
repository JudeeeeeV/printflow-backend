import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Request,
  Response,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { Throttle } from '@nestjs/throttler';
import {
  clearUserCookies,
  readCookie,
  setUserCookies,
  USER_ACCESS_COOKIE,
  USER_REFRESH_COOKIE,
} from './auth-cookies';

type AuthenticatedRequest = ExpressRequest & {
  user: { id: string; email?: string; role: string };
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() loginDto: LoginDto,
    @Response({ passthrough: true }) response: ExpressResponse,
  ) {
    const session = await this.authService.login(loginDto);
    setUserCookies(
      response,
      session.accessToken,
      session.refreshToken,
      session.expiresIn,
    );
    return {
      user: session.user,
      ...(process.env.NODE_ENV !== 'production'
        ? { token: session.accessToken }
        : {}),
    };
  }

  @Post('refresh')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(
    @Request() request: ExpressRequest,
    @Response({ passthrough: true }) response: ExpressResponse,
  ) {
    const refreshToken = readCookie(request, USER_REFRESH_COOKIE);
    if (!refreshToken)
      throw new UnauthorizedException('Refresh session missing');
    const session = await this.authService.refresh(refreshToken);
    setUserCookies(
      response,
      session.accessToken,
      session.refreshToken,
      session.expiresIn,
    );
    return { user: session.user };
  }

  @Post('logout')
  async logout(
    @Request() request: ExpressRequest,
    @Response({ passthrough: true }) response: ExpressResponse,
  ) {
    await this.authService.logout(readCookie(request, USER_ACCESS_COOKIE));
    clearUserCookies(response);
    return { success: true };
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  me(@Request() request: ExpressRequest & { user?: unknown }) {
    return { user: request.user };
  }

  @UseGuards(SupabaseAuthGuard)
  @Post('change-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(req.user.id, dto);
  }
}
