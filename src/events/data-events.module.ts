import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { DataEventsController } from './data-events.controller';
import { DataEventsService } from './data-events.service';

@Module({
  imports: [AdminModule],
  controllers: [DataEventsController],
  providers: [DataEventsService],
})
export class DataEventsModule {}
