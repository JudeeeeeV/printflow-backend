import { Module } from '@nestjs/common';
import { DataEventsController } from './data-events.controller';
import { DataEventsService } from './data-events.service';

@Module({
  controllers: [DataEventsController],
  providers: [DataEventsService],
})
export class DataEventsModule {}
