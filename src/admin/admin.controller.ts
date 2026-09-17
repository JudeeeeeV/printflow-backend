import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminService } from './admin.service';
import { AdminAuthGuard } from '../iam/guards/admin-auth.guard';
import { RequireAdminToken } from '../iam/decorators/admin-token.decorator';
import { AdminLoginDto } from './dto/admin-login.dto';
import { TotpDto } from './dto/totp.dto';
import { AddAdminDto } from './dto/add-admin.dto';
import { VerifyShopDto } from './dto/verify-shop.dto';
import { Throttle } from '@nestjs/throttler';
import {
  clearAdminCookies,
  setAdminAccessCookie,
  setAdminTempCookie,
} from '../auth/auth-cookies';
import { AdminAuditInterceptor } from './admin-audit.interceptor';

interface AdminRequest {
  user: { sub: string; jti?: string };
}

@Controller('admin')
@UseInterceptors(AdminAuditInterceptor)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('auth/login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() body: AdminLoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.adminService.login(body.email, body.password);
    setAdminTempCookie(response, result.temp_token);
    return result.requires_setup
      ? {
          requires_setup: true,
          qr_code_url: result.qr_code_url,
          secret: result.secret,
        }
      : { requires_2fa: true };
  }

  @Post('auth/setup-2fa')
  @UseGuards(AdminAuthGuard)
  @RequireAdminToken('admin-temp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async setup2fa(
    @Body() body: TotpDto,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.adminService.setup2FA(req.user.sub, body.token);
    setAdminAccessCookie(response, result.access_token);
    return { success: true };
  }

  @Post('auth/verify-2fa')
  @UseGuards(AdminAuthGuard)
  @RequireAdminToken('admin-temp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verify2fa(
    @Body() body: TotpDto,
    @Req() req: AdminRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.adminService.verify2FA(req.user.sub, body.token);
    setAdminAccessCookie(response, result.access_token);
    return { success: true };
  }

  @Post('auth/logout')
  @UseGuards(AdminAuthGuard)
  async logout(
    @Req() request: AdminRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (request.user.jti) {
      await this.adminService.revokeSession(request.user.sub, request.user.jti);
    }
    clearAdminCookies(response);
    return { success: true };
  }

  @Get('auth/session')
  @UseGuards(AdminAuthGuard)
  session() {
    return { authenticated: true };
  }

  @Get('shops/pending')
  @UseGuards(AdminAuthGuard)
  async getPendingShops() {
    return this.adminService.getPendingShops();
  }

  @Post('shops/:id/verify')
  @UseGuards(AdminAuthGuard)
  async verifyShop(@Param('id') shopId: string, @Body() body: VerifyShopDto) {
    return this.adminService.verifyShop(shopId, body.status, body.reason);
  }

  @Post('add')
  @UseGuards(AdminAuthGuard)
  async addAdmin(@Body() body: AddAdminDto) {
    return this.adminService.addAdmin(body.email, body.password);
  }

  @Get('disputes')
  @UseGuards(AdminAuthGuard)
  async getDisputes() {
    return this.adminService.getDisputes();
  }

  @Post('orders/:id/force-approve')
  @UseGuards(AdminAuthGuard)
  async forceApproveOrder(@Param('id') orderId: string) {
    return this.adminService.forceApproveOrder(orderId);
  }

  @Post('orders/:id/uphold-rejection')
  @UseGuards(AdminAuthGuard)
  async upholdRejection(@Param('id') orderId: string) {
    return this.adminService.upholdRejection(orderId);
  }

  @Get('daemon-devices')
  @UseGuards(AdminAuthGuard)
  async getDaemonDevices() {
    return this.adminService.getDaemonDevices();
  }

  @Post('daemon-devices/:id/revoke')
  @UseGuards(AdminAuthGuard)
  async revokeDaemonDevice(@Param('id') deviceId: string) {
    return this.adminService.revokeDaemonDevice(deviceId);
  }

  @Post('daemon-devices/:id/rescan')
  @UseGuards(AdminAuthGuard)
  async rescanDaemonDevice(@Param('id') deviceId: string) {
    return this.adminService.rescanDaemonDevice(deviceId);
  }
}
