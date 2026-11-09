import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { ShopQueueQueryDto } from './dto/shop-queue.dto';
import { ShopQueueService } from './shop-queue.service';

@Controller('orders/shop')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('CLERK', 'MANAGER')
export class ShopQueueController {
  constructor(private readonly queue: ShopQueueService) {}

  @Get('queue')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 600, ttl: 60000 } })
  query(
    @Req() request: { user: { id: string } },
    @Query() query: ShopQueueQueryDto,
  ) {
    return this.queue.query(request.user.id, query);
  }

  @Get('selection')
  @Header('Cache-Control', 'no-store')
  selection(
    @Req() request: { user: { id: string } },
    @Query() query: ShopQueueQueryDto,
  ) {
    return this.queue.items(request.user.id, query.onlyIds || []).then((rows) =>
      rows.map((row) => {
        const { source_path, raw_attempt, ...summary } = row;
        void source_path;
        void raw_attempt;
        return summary;
      }),
    );
  }

  @Get(':orderId')
  @Header('Cache-Control', 'no-store')
  details(
    @Req() request: { user: { id: string } },
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.queue.details(request.user.id, orderId);
  }
}
