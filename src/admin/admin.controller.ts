import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminAuthGuard } from '../iam/guards/admin-auth.guard';
import { RequireAdminToken } from '../iam/decorators/admin-token.decorator';
import { AdminLoginDto } from './dto/admin-login.dto';
import { TotpDto } from './dto/totp.dto';
import { AddAdminDto } from './dto/add-admin.dto';
import { VerifyShopDto } from './dto/verify-shop.dto';
import { Throttle } from '@nestjs/throttler';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('auth/login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() body: AdminLoginDto) {
    return this.adminService.login(body.email, body.password);
  }

  @Post('auth/setup-2fa')
  @UseGuards(AdminAuthGuard)
  @RequireAdminToken('admin-temp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async setup2fa(@Body() body: TotpDto, @Req() req: any) {
    return this.adminService.setup2FA(req.user.sub, body.token);
  }

  @Post('auth/verify-2fa')
  @UseGuards(AdminAuthGuard)
  @RequireAdminToken('admin-temp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verify2fa(@Body() body: TotpDto, @Req() req: any) {
    return this.adminService.verify2FA(req.user.sub, body.token);
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
}
