import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import { DaemonDevicesService } from './daemon-devices.service';
import { RegisterDaemonDeviceDto } from './dto/register-daemon-device.dto';
import { ExchangeDaemonTokenDto } from './dto/exchange-daemon-token.dto';

interface ShopRequest extends Request {
  user: { id: string; role: string };
}

@Controller('daemon-devices')
export class DaemonDevicesController {
  constructor(private readonly devices: DaemonDevicesService) {}

  @Post('token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  exchangeToken(@Body() dto: ExchangeDaemonTokenDto) {
    return this.devices.exchangeToken(dto);
  }

  @Post('register')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Req() request: ShopRequest, @Body() dto: RegisterDaemonDeviceDto) {
    return this.devices.register(request.user.id, request.user.role, dto);
  }

  @Get('mine')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  listMine(@Req() request: ShopRequest) {
    return this.devices.listForShop(request.user.id, request.user.role);
  }

  @Post(':id/revoke')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  revoke(@Req() request: ShopRequest, @Param('id') deviceId: string) {
    return this.devices.revokeForShop(
      deviceId,
      request.user.id,
      request.user.role,
    );
  }

  @Post(':id/rescan')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  rescan(@Req() request: ShopRequest, @Param('id') deviceId: string) {
    return this.devices.requestPrinterRescan(
      deviceId,
      request.user.id,
      request.user.role,
    );
  }
}
