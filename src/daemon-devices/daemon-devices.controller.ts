import {
  Body,
  Controller,
  ForbiddenException,
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
import { BootstrapDaemonDeviceDto } from './dto/bootstrap-daemon-device.dto';
import { AuthService } from '../auth/auth.service';

interface ShopRequest extends Request {
  user: { id: string; role: string };
}

@Controller('daemon-devices')
export class DaemonDevicesController {
  constructor(
    private readonly devices: DaemonDevicesService,
    private readonly auth: AuthService,
  ) {}

  @Post('bootstrap')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async bootstrap(@Body() dto: BootstrapDaemonDeviceDto) {
    const session = await this.auth.login({
      email: dto.email,
      password: dto.password,
    });
    try {
      if (session.user.roleTag !== 'Print Shop') {
        throw new ForbiddenException(
          'A verified print-shop account is required',
        );
      }
      return await this.devices.register(session.user.id, 'CLERK', {
        deviceName: dto.deviceName,
        agentVersion: dto.agentVersion,
      });
    } finally {
      await this.auth.logout(session.accessToken);
    }
  }

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
