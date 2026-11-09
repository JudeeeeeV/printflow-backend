import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';
import { ShopQueueService } from './shop-queue.service';
import { ShopQueueController } from './shop-queue.controller';

@Module({
  controllers: [ShopQueueController, OrdersController],
  providers: [OrdersService, PrintableDocumentService, ShopQueueService],
  exports: [PrintableDocumentService, ShopQueueService],
})
export class OrdersModule {}
