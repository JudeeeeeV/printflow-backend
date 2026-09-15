import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { PrintSpoolerService } from './print-spooler.service';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { ExecuteBatchDto } from './dto/execute-batch.dto';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

@Controller('edge')
export class EdgeController {
  constructor(private readonly printSpoolerService: PrintSpoolerService) {}

  @Post('batch-execute')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async executeBatch(
    @Req() request: AuthenticatedRequest,
    @Body() body: ExecuteBatchDto,
  ) {
    const shopId = request.user.id;
    return this.printSpoolerService.executeBatch(
      body.orderIds,
      shopId,
      body.printerName,
    );
  }
}
