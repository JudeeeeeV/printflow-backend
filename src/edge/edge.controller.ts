import { Controller, Post, Body, Param, UseGuards } from '@nestjs/common';
import { PrintSpoolerService } from './print-spooler.service';

@Controller('edge')
export class EdgeController {
  constructor(private readonly printSpoolerService: PrintSpoolerService) {}

  @Post('batch-execute/:shopId')
  async executeBatch(
    @Param('shopId') shopId: string,
    @Body('orderIds') orderIds: string[],
    @Body('printerName') printerName?: string,
  ) {
    return this.printSpoolerService.executeBatch(orderIds, shopId, printerName);
  }
}
