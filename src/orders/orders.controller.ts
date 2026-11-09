import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { SubmitDraftDto, UpdateDraftDto } from './dto/update-draft.dto';
import { VerifyPaymentDto } from './dto/verify-payment.dto';
import { UpdateOrderStateDto } from './dto/update-order-state.dto';
import { OrderDecisionDto, PaymentDisputeDto } from './dto/order-decision.dto';
import { UploadReceiptDto } from './dto/upload-receipt.dto';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import type { Request } from 'express';
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  secureUploadOptions,
} from '../common/upload-security';
import { Throttle } from '@nestjs/throttler';
import { DocumentUploadInterceptor } from '../common/document-upload.interceptor';
import { DocumentUploadException } from '../common/document-upload-error';
import { IdempotencyKeyGuard } from './idempotency-key.guard';

type OrderRequest = Request & { user: { id: string }; operationKey?: string };

@Controller('orders')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @Roles('STUDENT')
  async getUserOrders(
    @Req() req: OrderRequest,
    @Query('sortByDate') sortByDate?: 'asc' | 'desc',
    @Query('status') status?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const userId = req.user.id;
    return this.ordersService.getUserOrders(
      userId,
      sortByDate,
      status,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  @Get('shop')
  @Roles('CLERK', 'MANAGER')
  async getShopOrders(@Req() req: OrderRequest) {
    const shopId = req.user.id;
    return this.ordersService.getShopOrders(shopId);
  }

  @Get('drafts')
  @Roles('STUDENT')
  async getDrafts(
    @Req() req: OrderRequest,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '10',
  ) {
    const userId = req.user.id;
    return this.ordersService.getDrafts(
      userId,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }

  @Get('operations/:operationKey')
  @Roles('STUDENT')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async getOperation(
    @Param('operationKey', ParseUUIDPipe) operationKey: string,
    @Req() req: OrderRequest,
  ) {
    return this.ordersService.operationStatus(req.user.id, operationKey);
  }

  @Get(':id')
  @Roles('STUDENT')
  // Limits are per IP. Checkout polls this, and students may share a campus IP.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async getOrder(@Param('id') orderId: string, @Req() req: OrderRequest) {
    const userId = req.user.id;
    return this.ordersService.getOrder(userId, orderId);
  }

  @Post()
  @Roles('STUDENT')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(IdempotencyKeyGuard)
  @UseInterceptors(DocumentUploadInterceptor)
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: OrderRequest,
  ) {
    const userId = req.user.id;
    if (!file) {
      throw new DocumentUploadException('EMPTY_FILE');
    }
    // createOrderDto will now optionally carry the { isDraft: true } flag from the frontend
    return this.ordersService.createOrder(
      userId,
      createOrderDto,
      file,
      req.operationKey,
    );
  }

  @Patch(':id/submit')
  @Roles('STUDENT')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(IdempotencyKeyGuard)
  @UseInterceptors(DocumentUploadInterceptor)
  async submitDraft(
    @Param('id') draftId: string,
    @Req() req: OrderRequest,
    @Body() body: SubmitDraftDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const userId = req.user.id;
    const { paymentMethod, expectedVersion, ...settings } = body ?? {};
    return this.ordersService.submitDraft(userId, draftId, paymentMethod, {
      settings: settings.shopId
        ? ({ ...settings, paymentMethod } as UpdateDraftDto)
        : undefined,
      expectedVersion,
      file,
      operationKey: req.operationKey,
    });
  }

  @Patch(':id/update-draft')
  @Roles('STUDENT')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(IdempotencyKeyGuard)
  @UseInterceptors(DocumentUploadInterceptor)
  async updateDraft(
    @Param('id') draftId: string,
    @Body() body: UpdateDraftDto,
    @Req() req: OrderRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const userId = req.user.id;
    return this.ordersService.updateDraft(
      userId,
      draftId,
      body,
      file,
      req.operationKey,
    );
  }

  @Delete(':id/draft')
  @Roles('STUDENT')
  async deleteDraft(@Param('id') draftId: string, @Req() req: OrderRequest) {
    const userId = req.user.id;
    return this.ordersService.deleteDraft(userId, draftId);
  }

  @Post(':id/receipt')
  @Roles('STUDENT')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(IdempotencyKeyGuard)
  @UseInterceptors(
    FileInterceptor(
      'receiptFile',
      secureUploadOptions(IMAGE_MIME_TYPES, MAX_IMAGE_BYTES),
    ),
  )
  async uploadReceipt(
    @Param('id') orderId: string,
    @UploadedFile() receiptFile: Express.Multer.File,
    @Body() body: UploadReceiptDto,
    @Req() req: OrderRequest,
  ) {
    if (!receiptFile) {
      throw new BadRequestException('Receipt image is required');
    }
    const userId = req.user.id;
    return this.ordersService.submitPaymentReceipt(
      userId,
      orderId,
      receiptFile,
      body.referenceNumber,
      req.operationKey,
    );
  }

  @Post(':id/verify-payment')
  @Roles('CLERK', 'MANAGER')
  async verifyPayment(
    @Param('id') orderId: string,
    @Body() body: VerifyPaymentDto,
    @Req() req: OrderRequest,
  ) {
    const clerkId = req.user.id;
    return this.ordersService.verifyPayment(
      clerkId,
      orderId,
      body.action,
      body.reason,
      body.receiptId,
      body.confirmed,
    );
  }

  @Post(':id/decision')
  @Roles('CLERK', 'MANAGER')
  async decideOrder(
    @Param('id') orderId: string,
    @Body() body: OrderDecisionDto,
    @Req() req: OrderRequest,
  ) {
    const shopId = req.user.id;
    return this.ordersService.decideOrder(shopId, orderId, body.action, {
      reason: body.reason,
      reference: body.reference,
      confirmed: body.confirmed,
    });
  }

  @Delete(':id')
  @Roles('STUDENT')
  async cancelOrder(@Param('id') orderId: string, @Req() req: OrderRequest) {
    const userId = req.user.id;
    return this.ordersService.cancelOrder(userId, orderId);
  }

  @Post(':id/dispute-payment')
  @Roles('STUDENT')
  async disputePayment(
    @Param('id') orderId: string,
    @Body() body: PaymentDisputeDto,
    @Req() req: OrderRequest,
  ) {
    if (!body.reason.trim()) {
      throw new BadRequestException(
        'A reason must be provided for the dispute.',
      );
    }
    const userId = req.user.id;
    return this.ordersService.disputePayment(
      userId,
      orderId,
      body.reason.trim(),
    );
  }

  @Patch(':id/state')
  @Roles('CLERK', 'MANAGER')
  async updateOrderState(
    @Param('id') orderId: string,
    @Body() body: UpdateOrderStateDto,
    @Req() req: OrderRequest,
  ) {
    const shopId = (req as any).user.id;
    return this.ordersService.updateOrderState(shopId, orderId, body.state, {
      expectedAttemptId: body.expectedAttemptId,
      confirmed: body.confirmed,
      checks: body.checks,
      reconciliationReason: body.reconciliationReason,
    });
  }
}
