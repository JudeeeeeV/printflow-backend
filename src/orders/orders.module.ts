import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrintableDocumentService } from './printable-document.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, PrintableDocumentService],
  exports: [PrintableDocumentService],
})
export class OrdersModule {}
