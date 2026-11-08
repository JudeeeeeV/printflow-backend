import {
  Controller,
  Post,
  Get,
  Patch,
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
import { TurnstileService } from './turnstile.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { Throttle } from '@nestjs/throttler';
import {
  bearerToken,
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
  constructor(
    private readonly authService: AuthService,
    private readonly turnstile: TurnstileService,
  ) {}

  @Get('login')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  loginPage(@Response() response: ExpressResponse) {
    const frontendUrl =
      process.env.FRONTEND_URL || 'http://localhost:5173';
    return response.redirect(`${frontendUrl}/auth`);
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() loginDto: LoginDto,
    @Response({ passthrough: true }) response: ExpressResponse,
  ) {
    await this.turnstile.assertHuman(loginDto.captchaToken);
    const session = await this.authService.login(loginDto);
    setUserCookies(
      response,
      session.accessToken,
      session.refreshToken,
      session.expiresIn,
    );
    return {
      user: session.user,
      token: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  @Post('refresh')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(
    @Request() request: ExpressRequest,
    @Response({ passthrough: true }) response: ExpressResponse,
    @Body() body?: RefreshDto,
  ) {
    const refreshToken =
      readCookie(request, USER_REFRESH_COOKIE) || body?.refreshToken;
    if (!refreshToken)
      throw new UnauthorizedException('Refresh session missing');
    const session = await this.authService.refresh(refreshToken);
    setUserCookies(
      response,
      session.accessToken,
      session.refreshToken,
      session.expiresIn,
    );
    return {
      user: session.user,
      token: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  @Post('logout')
  async logout(
    @Request() request: ExpressRequest,
    @Response({ passthrough: true }) response: ExpressResponse,
  ) {
    const token =
      bearerToken(request) || readCookie(request, USER_ACCESS_COOKIE);
    await this.authService.logout(token);
    clearUserCookies(response);
    return { success: true };
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  me(@Request() request: ExpressRequest & { user?: unknown }) {
    const token =
      bearerToken(request) || readCookie(request, USER_ACCESS_COOKIE);
    return {
      user: request.user,
      ...(token ? { token } : {}),
    };
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

  @Get('profile')
  @UseGuards(SupabaseAuthGuard)
  getProfile(@Request() req: AuthenticatedRequest) {
    return this.authService.getProfile(req.user.id);
  }

  @Patch('profile')
  @UseGuards(SupabaseAuthGuard)
  updateProfile(@Request() req: AuthenticatedRequest, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(req.user.id, dto);
  }
}
