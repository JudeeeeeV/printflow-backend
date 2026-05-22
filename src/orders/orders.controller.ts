import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
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
  async getUserOrders(@Req() req: Request) {
    const userId = (req as any).user.id;
    return this.ordersService.getUserOrders(userId);
  }

  @Get(':id')
  @Roles('STUDENT')
  async getOrder(@Param('id') orderId: string, @Req() req: Request) {
    const userId = (req as any).user.id;
    return this.ordersService.getOrder(userId, orderId);
  }

  @Post()
  @Roles('STUDENT')
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @Req() req: Request,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
    const userId = (req as any).user.id;
    return this.ordersService.createOrder(userId, createOrderDto);
  }

  @Post(':id/receipt')
  @Roles('STUDENT')
  async uploadReceipt(
    @Param('id') orderId: string,
    @Body() uploadReceiptDto: UploadReceiptDto,
    @Req() req: Request,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access
    const userId = (req as any).user.id;
    return this.ordersService.uploadReceipt(userId, orderId, uploadReceiptDto);
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
}