import { Controller, Get, Post, Delete, Patch, Body, Param, Req, UseGuards, UseInterceptors, UploadedFile, BadRequestException, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UploadReceiptDto } from './dto/upload-receipt.dto';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import type { Request } from 'express';

@Controller('orders')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @Roles('STUDENT')
  async getUserOrders(
    @Req() req: Request,
    @Query('sortByDate') sortByDate?: 'asc' | 'desc',
    @Query('status') status?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const userId = (req as any).user.id;
    return this.ordersService.getUserOrders(userId, sortByDate, status, parseInt(page, 10), parseInt(limit, 10));
  }

  @Get('shop')
  @Roles('CLERK', 'MANAGER')
  async getShopOrders(@Req() req: Request) {
    const shopId = (req as any).user.id;
    return this.ordersService.getShopOrders(shopId);
  }

  @Get('drafts')
  @Roles('STUDENT')
  async getDrafts(
    @Req() req: Request,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const userId = (req as any).user.id;
    return this.ordersService.getDrafts(userId, parseInt(page, 10), parseInt(limit, 10));
  }

  @Get(':id')
  @Roles('STUDENT')
  async getOrder(@Param('id') orderId: string, @Req() req: Request) {
    const userId = (req as any).user.id;
    return this.ordersService.getOrder(userId, orderId);
  }

  @Post()
  @Roles('STUDENT')
  @UseInterceptors(FileInterceptor('file'))
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
    const userId = (req as any).user.id;
    if (!file) {
      throw new BadRequestException('Asset file is required');
    }
    // createOrderDto will now optionally carry the { isDraft: true } flag from the frontend
    return this.ordersService.createOrder(userId, createOrderDto, file);
  }

  @Patch(':id/submit')
  @Roles('STUDENT')
  async submitDraft(
    @Param('id') draftId: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).user.id;
    return this.ordersService.submitDraft(userId, draftId);
  }

  @Patch(':id/update-draft')
  @Roles('STUDENT')
  async updateDraft(
    @Param('id') draftId: string,
    @Body() body: { shopId: string; paperSize: string; printColorMode: string; total: number; pageCount: number },
    @Req() req: Request,
  ) {
    const userId = (req as any).user.id;
    return this.ordersService.updateDraft(userId, draftId, body);
  }

  @Delete(':id/draft')
  @Roles('STUDENT')
  async deleteDraft(
    @Param('id') draftId: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).user.id;
    return this.ordersService.deleteDraft(userId, draftId);
  }

  @Post(':id/receipt')
  @Roles('STUDENT')
  @UseInterceptors(FileInterceptor('receiptFile'))
  async uploadReceipt(
    @Param('id') orderId: string,
    @UploadedFile() receiptFile: Express.Multer.File,
    @Body('referenceNumber') referenceNumber: string | undefined,
    @Req() req: Request,
  ) {
    if (!receiptFile) {
      throw new BadRequestException('Receipt image is required');
    }
    const userId = (req as any).user.id;
    return this.ordersService.submitPaymentReceipt(userId, orderId, receiptFile, referenceNumber);
  }

  @Post(':id/verify-payment')
  @Roles('CLERK', 'MANAGER')
  async verifyPayment(
    @Param('id') orderId: string,
    @Body() body: { action: 'APPROVE' | 'REJECT', reason?: string },
    @Req() req: Request,
  ) {
    const clerkId = (req as any).user.id;
    return this.ordersService.verifyPayment(clerkId, orderId, body.action, body.reason);
  }

  @Delete(':id')
  @Roles('STUDENT')
  async cancelOrder(
    @Param('id') orderId: string,
    @Req() req: Request,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
    const userId = (req as any).user.id;
    return this.ordersService.cancelOrder(userId, orderId);
  }

  @Post(':id/dispute-payment')
  @Roles('STUDENT')
  async disputePayment(
    @Param('id') orderId: string,
    @Body('reason') reason: string,
    @Req() req: Request,
  ) {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason must be provided for the dispute.');
    }
    const userId = (req as any).user.id;
    return this.ordersService.disputePayment(userId, orderId, reason);
  }

  @Patch(':id/state')
  @Roles('CLERK', 'MANAGER')
  async updateOrderState(
    @Param('id') orderId: string,
    @Body('state') state: string,
    @Req() req: Request,
  ) {
    const shopId = (req as any).user.id;
    return this.ordersService.updateOrderState(shopId, orderId, state);
  }
}