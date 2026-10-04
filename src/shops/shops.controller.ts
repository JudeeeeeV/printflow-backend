import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { UpdateShopDto } from './dto/update-shop.dto';
import { MAX_SHOP_PHOTO_BYTES } from './shop-photo';

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
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async updateMyShop(@Req() req: Request, @Body() body: UpdateShopDto) {
    const userId = (req as any).user.id;
    return this.shopsService.updateShop(userId, body);
  }

  @Post('me/photo')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  @Throttle({ default: { limit: 10, ttl: 3_600_000 } })
  @UseInterceptors(
    FileInterceptor('photo', {
      ...secureUploadOptions(IMAGE_MIME_TYPES, MAX_SHOP_PHOTO_BYTES),
      limits: { fileSize: MAX_SHOP_PHOTO_BYTES, files: 1, fields: 0 },
    }),
  )
  async uploadShopPhoto(
    @Req() req: Request & { user: { id: string } },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Shop photo is required.');
    return this.shopsService.uploadShopPhoto(req.user.id, file);
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

  @Delete('gcash-qr')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @Roles('CLERK', 'MANAGER')
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  async removeGcashQr(@Req() req: Request & { user: { id: string } }) {
    return this.shopsService.removeGcashQr(req.user.id);
  }
}
