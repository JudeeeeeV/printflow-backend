import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrintSpoolerService } from './print-spooler.service';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { ExecuteBatchDto, ManualProductionDto } from './dto/execute-batch.dto';
import {
  ReconciliationNoteDto,
  ReprintOrderDto,
  RetryAttemptDto,
} from './dto/attempt-actions.dto';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

@Controller('edge')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('CLERK', 'MANAGER')
export class EdgeController {
  constructor(private readonly printSpoolerService: PrintSpoolerService) {}

  @Post('batch-execute')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async executeBatch(
    @Req() request: AuthenticatedRequest,
    @Body() body: ExecuteBatchDto,
  ) {
    const shopId = request.user.id;
    return this.printSpoolerService.executeBatch({
      orderIds: body.orderIds,
      shopId,
      actorId: request.user.id,
      printerName: body.printerName,
      requestId: body.requestId,
    });
  }

  @Post('manual-production')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async startManualProduction(
    @Req() request: AuthenticatedRequest,
    @Body() body: ManualProductionDto,
  ) {
    return this.printSpoolerService.startManualProduction({
      orderIds: body.orderIds,
      shopId: request.user.id,
      actorId: request.user.id,
      requestId: body.requestId,
    });
  }

  @Get('orders/:orderId/attempts')
  async history(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.printSpoolerService.history(request.user.id, orderId);
  }

  @Post('attempts/:attemptId/retry')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async retry(
    @Req() request: AuthenticatedRequest,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body() body: RetryAttemptDto,
  ) {
    return this.printSpoolerService.retryAttempt({
      attemptId,
      shopId: request.user.id,
      actorId: request.user.id,
      mode: body.mode,
      printerName: body.printerName,
      reason: body.reason,
      queueCleared: body.queueCleared,
    });
  }

  @Post('attempts/:attemptId/still-uncertain')
  async stillUncertain(
    @Req() request: AuthenticatedRequest,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @Body() body: ReconciliationNoteDto,
  ) {
    return this.printSpoolerService.recordStillUncertain({
      attemptId,
      shopId: request.user.id,
      actorId: request.user.id,
      reason: body.reason,
    });
  }

  @Post('orders/:orderId/reprint')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async reprint(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: ReprintOrderDto,
  ) {
    return this.printSpoolerService.reprintOrder({
      orderId,
      shopId: request.user.id,
      actorId: request.user.id,
      expectedAttemptId: body.expectedAttemptId ?? null,
      mode: body.mode,
      printerName: body.printerName,
      reason: body.reason,
      confirmFullJob: body.confirmFullJob,
    });
  }
}
