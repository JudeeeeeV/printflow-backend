import { Controller, Post, Body, Get, Param, UseGuards, Req } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminAuthGuard } from '../iam/guards/admin-auth.guard';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('auth/login')
  async login(@Body() body: any) {
    return this.adminService.login(body.email, body.password);
  }

  @Post('auth/setup-2fa')
  @UseGuards(AdminAuthGuard)
  async setup2fa(@Body() body: any, @Req() req: any) {
    return this.adminService.setup2FA(req.user.sub, body.token);
  }

  @Post('auth/verify-2fa')
  @UseGuards(AdminAuthGuard)
  async verify2fa(@Body() body: any, @Req() req: any) {
    return this.adminService.verify2FA(req.user.sub, body.token);
  }

  @Get('shops/pending')
  @UseGuards(AdminAuthGuard)
  async getPendingShops() {
    return this.adminService.getPendingShops();
  }

  @Post('shops/:id/verify')
  @UseGuards(AdminAuthGuard)
  async verifyShop(
    @Param('id') shopId: string,
    @Body() body: { status: 'VERIFIED' | 'REJECTED'; reason?: string }
  ) {
    return this.adminService.verifyShop(shopId, body.status, body.reason);
  }

  @Post('add')
  @UseGuards(AdminAuthGuard)
  async addAdmin(@Body() body: any) {
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
