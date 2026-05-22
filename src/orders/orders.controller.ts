import { Controller, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UploadReceiptDto } from './dto/upload-receipt.dto';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import type { Request } from 'express';

@Controller('orders')
@UseGuards(SupabaseAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @Req() req: Request,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
    const userId = (req as any).user.id;
    return this.ordersService.createOrder(userId, createOrderDto);
  }

  @Post(':id/receipt')
  async uploadReceipt(
    @Param('id') orderId: string,
    @Body() uploadReceiptDto: UploadReceiptDto,
    @Req() req: Request,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
    const userId = (req as any).user.id;
    return this.ordersService.uploadReceipt(userId, orderId, uploadReceiptDto);
  }
}