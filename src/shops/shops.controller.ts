import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  UseGuards,
  Req,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ShopsService } from './shops.service';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';
import type { Request } from 'express';
import {
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  secureUploadOptions,
} from '../common/upload-security';
import { Throttle } from '@nestjs/throttler';

@Controller('shops')
export class ShopsController {
  constructor(private readonly shopsService: ShopsService) {}

  @Get()
  async getShops() {
    return this.shopsService.getVerifiedShops();
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  async getMyShop(@Req() req: Request) {
    const userId = (req as any).user.id;
    return this.shopsService.getShopById(userId);
  }

  @Patch('me')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  async updateMyShop(
    @Req() req: Request,
    @Body() body: { name?: string; location?: string; description?: string },
  ) {
    const userId = (req as any).user.id;
    return this.shopsService.updateShop(userId, body);
  }

  @Post('verify')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @UseInterceptors(
    FileInterceptor(
      'permit',
      secureUploadOptions(DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES),
    ),
  )
  async verifyPermit(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Permit file is required');
    }

    const userId = (req as any).user.id;
    return this.shopsService.verifyPermit(userId, file);
  }

  @Post('gcash-qr')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @UseInterceptors(
    FileInterceptor(
      'qrCode',
      secureUploadOptions(IMAGE_MIME_TYPES, MAX_IMAGE_BYTES),
    ),
  )
  async uploadGcashQr(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('QR Code file is required');
    }

    const userId = (req as any).user.id;
    return this.shopsService.uploadGcashQr(userId, file);
  }
}
