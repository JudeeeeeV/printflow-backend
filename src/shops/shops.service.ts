import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import OpenAI from 'openai';
import { UpdateShopDto } from './dto/update-shop.dto';
import { normalizeShopPhoto, SHOP_PHOTO_BUCKET } from './shop-photo';
import {
  assertFileSignature,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  secureObjectName,
} from '../common/upload-security';

@Injectable()
export class ShopsService {
  private readonly logger = new Logger(ShopsService.name);
  private readonly openai: OpenAI | null;
  private readonly aiPermitReviewEnabled: boolean;

  constructor(private supabaseService: SupabaseService) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.aiPermitReviewEnabled = process.env.ENABLE_AI_PERMIT_REVIEW === 'true';
  }

  async getVerifiedShops() {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select(
        'id, name, status, verification_status, pricing_matrix, location, latitude, longitude, shop_photo_path',
      )
      .eq('status', 'OPEN')
      .eq('verification_status', 'VERIFIED');

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return Promise.all(
      (data || []).map(async ({ shop_photo_path, ...shop }) => ({
        ...shop,
        shop_photo_url: await this.signShopPhoto(shop.id, shop_photo_path),
      })),
    );
  }

  async getShopById(shopId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select('*')
      .eq('id', shopId)
      .single();

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    const { shop_photo_path, ...shop } = data;
    const [shopPhotoUrl, permitUrl, qrUrl] = await Promise.all([
      this.signShopPhoto(shopId, shop_photo_path),
      this.supabaseService.createSignedStorageUrl('permits', data.business_permit_url, 300),
      this.supabaseService.createSignedStorageUrl('gcash_qrs', data.gcash_qr_url, 300),
    ]);
    return {
      ...shop,
      shop_photo_url: shopPhotoUrl,
      business_permit_url: permitUrl,
      gcash_qr_url: qrUrl,
    };
  }

  async updateShop(shopId: string, updateData: UpdateShopDto) {
    const supabase = this.supabaseService.getAdminClient();

    const { latitude, longitude } = updateData;
    if (latitude !== undefined || longitude !== undefined) {
      const clearing = latitude === null && longitude === null;
      const validPair =
        typeof latitude === 'number' &&
        Number.isFinite(latitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        typeof longitude === 'number' &&
        Number.isFinite(longitude) &&
        longitude >= -180 &&
        longitude <= 180;
      if (!clearing && !validPair) {
        throw new BadRequestException(
          'Provide both valid coordinates, or clear both coordinates.',
        );
      }
    }
    const payload: UpdateShopDto = {};
    if (updateData.name !== undefined) {
      payload.name = updateData.name.trim();
      if (!payload.name)
        throw new BadRequestException('Shop name cannot be empty.');
    }
    if (updateData.location !== undefined)
      payload.location = updateData.location.trim();
    if (updateData.description !== undefined)
      payload.description = updateData.description.trim();
    if (latitude !== undefined) payload.latitude = latitude;
    if (longitude !== undefined) payload.longitude = longitude;
    if (!Object.keys(payload).length)
      throw new BadRequestException('No shop settings provided.');

    const { data, error } = await supabase
      .from('shops')
      .update(payload)
      .eq('id', shopId)
      .select('id, name, location, description, latitude, longitude')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new NotFoundException('No shop is associated with this account.');
      }
      throw new InternalServerErrorException(
        `Failed to update shop: ${error.message}`,
      );
    }

    return data;
  }

  async ensurePermitsBucket() {
    await this.supabaseService.ensurePrivateBucket('permits');
  }

  private async signShopPhoto(shopId: string, path: string | null | undefined) {
    if (!path || !path.startsWith(`${shopId}/`) || path.includes('..'))
      return null;
    return this.supabaseService.createSignedStorageUrl(
      SHOP_PHOTO_BUCKET,
      path,
      3600,
    );
  }

  private async removeShopPhotoObject(shopId: string, path: string) {
    if (!path.startsWith(`${shopId}/`) || path.includes('..')) return;
    try {
      const { error } = await this.supabaseService
        .getAdminClient()
        .storage.from(SHOP_PHOTO_BUCKET)
        .remove([path]);
      if (error) this.logger.warn('Could not clean up an unused shop photo.');
    } catch {
      this.logger.warn('Could not clean up an unused shop photo.');
    }
  }

  async uploadShopPhoto(shopId: string, file: Express.Multer.File) {
    const client = this.supabaseService.getAdminClient();
    const { data: shop, error: shopError } = await client
      .from('shops')
      .select('id, shop_photo_path')
      .eq('id', shopId)
      .single();
    if (shopError?.code === 'PGRST116' || (!shopError && !shop)) {
      throw new NotFoundException('No shop is associated with this account.');
    }
    if (shopError)
      throw new InternalServerErrorException(
        'Could not load shop photo settings.',
      );

    const photo = await normalizeShopPhoto(file);
    await this.supabaseService.ensurePrivateBucket(SHOP_PHOTO_BUCKET);
    const path = secureObjectName(shopId, 'image/webp');
    const { error: uploadError } = await client.storage
      .from(SHOP_PHOTO_BUCKET)
      .upload(path, photo, {
        contentType: 'image/webp',
        cacheControl: '3600',
        upsert: false,
      });
    if (uploadError)
      throw new InternalServerErrorException(
        'Could not upload the shop photo. Please try again.',
      );

    // Compare-and-swap prevents concurrent replacements from deleting the active photo.
    const oldPath: string | null = shop.shop_photo_path ?? null;
    let update = client
      .from('shops')
      .update({ shop_photo_path: path })
      .eq('id', shopId);
    update =
      oldPath === null
        ? update.is('shop_photo_path', null)
        : update.eq('shop_photo_path', oldPath);
    const { data: updated, error: updateError } = await update
      .select('id')
      .maybeSingle();
    if (updateError || !updated) {
      await this.removeShopPhotoObject(shopId, path);
      if (!updateError)
        throw new ConflictException(
          'The shop photo changed in another session. Reload and try again.',
        );
      throw new InternalServerErrorException(
        'Could not save the shop photo. Please try again.',
      );
    }
    if (oldPath) await this.removeShopPhotoObject(shopId, oldPath);
    return { shop_photo_url: await this.signShopPhoto(shopId, path) };
  }

  async ensureGcashQrsBucket() {
    await this.supabaseService.ensurePrivateBucket('gcash_qrs');
  }

  async verifyPermit(shopId: string, file: Express.Multer.File) {
    assertFileSignature(file, DOCUMENT_MIME_TYPES);
    await this.ensurePermitsBucket();
    const supabase = this.supabaseService.getAdminClient();

    const fileName = secureObjectName(shopId, file.mimetype);
    const { error: uploadError } = await supabase.storage
      .from('permits')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload permit: ${uploadError.message}`,
      );
    }

    let aiSuggestion = 'DENY'; // Default to DENY to enforce ACCEPT/DENY binary
    let aiReasoning = 'Queued for manual review.';

    if (this.aiPermitReviewEnabled && this.openai) {
      try {
        const reviewUrl = await this.supabaseService.createSignedStorageUrl(
          'permits',
          fileName,
          600,
        );
        if (!reviewUrl) throw new Error('Permit review URL is unavailable');
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are a compliance assistant evaluating business permits. Extract text, check dates, and verify the business name. Output JSON strictly matching this schema: { "action": "ACCEPT" | "DENY", "reasoning": "Your reasoning here..." }',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Please review this business permit.' },
                {
                  type: 'image_url',
                  image_url: {
                    url: reviewUrl,
                  },
                },
              ],
            },
          ],
          max_tokens: 300,
        });

        const responseContent = response.choices[0].message.content;
        if (responseContent) {
          const parsed = JSON.parse(responseContent);
          // Force uppercase and fallback to DENY if it doesn't explicitly say ACCEPT
          const rawAction = String(parsed.action || '')
            .toUpperCase()
            .trim();
          aiSuggestion = rawAction === 'ACCEPT' ? 'ACCEPT' : 'DENY';
          aiReasoning = parsed.reasoning || 'No reasoning provided.';
        }
      } catch {
        this.logger.warn(
          'Automated permit review failed; manual review is required',
        );
        aiSuggestion = 'DENY';
        aiReasoning =
          'Automated review was unavailable. Please review manually.';
      }
    }

    const { data: updateData, error: updateError } = await supabase
      .from('shops')
      .update({
        business_permit_url: fileName,
        verification_status: 'PENDING_REVIEW',
        ai_suggestion: aiSuggestion,
        ai_reasoning: aiReasoning,
      })
      .eq('id', shopId)
      .select()
      .single();

    if (updateError) {
      throw new InternalServerErrorException(
        `Failed to update shop status: ${updateError.message}`,
      );
    }

    return {
      ...updateData,
      business_permit_url: await this.supabaseService.createSignedStorageUrl(
        'permits',
        fileName,
        300,
      ),
    };
  }

  async uploadGcashQr(shopId: string, file: Express.Multer.File) {
    assertFileSignature(file, IMAGE_MIME_TYPES);
    await this.ensureGcashQrsBucket();
    const supabase = this.supabaseService.getAdminClient();

    const fileName = secureObjectName(shopId, file.mimetype);
    const { error: uploadError } = await supabase.storage
      .from('gcash_qrs')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload GCash QR: ${uploadError.message}`,
      );
    }

    const { data: updateData, error: updateError } = await supabase
      .from('shops')
      .update({
        gcash_qr_url: fileName,
      })
      .eq('id', shopId)
      .select()
      .single();

    if (updateError) {
      throw new InternalServerErrorException(
        `Failed to update GCash QR URL: ${updateError.message}`,
      );
    }

    return {
      ...updateData,
      gcash_qr_url: await this.supabaseService.createSignedStorageUrl(
        'gcash_qrs',
        fileName,
        300,
      ),
    };
  }
}
