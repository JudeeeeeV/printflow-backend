import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import OpenAI from 'openai';
import {
  assertFileSignature,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  secureObjectName,
} from '../common/upload-security';

@Injectable()
export class ShopsService {
  private readonly openai: OpenAI | null;

  constructor(private supabaseService: SupabaseService) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async getVerifiedShops() {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select('id, name, status, verification_status, pricing_matrix')
      .eq('status', 'OPEN')
      .eq('verification_status', 'VERIFIED');

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data || [];
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
    return {
      ...data,
      business_permit_url: await this.supabaseService.createSignedStorageUrl(
        'permits',
        data.business_permit_url,
        300,
      ),
      gcash_qr_url: await this.supabaseService.createSignedStorageUrl(
        'gcash_qrs',
        data.gcash_qr_url,
        300,
      ),
    };
  }

  async updateShop(
    shopId: string,
    updateData: { name?: string; location?: string; description?: string },
  ) {
    const supabase = this.supabaseService.getAdminClient();

    // Map frontend fields to DB fields if needed, currently DB has 'name'.
    // We'll update what's provided. Assuming 'location' or 'description' exist, if not, Supabase ignores or throws.
    // Let's check what fields exist or just pass them in.
    const payload: any = {};
    if (updateData.name !== undefined) payload.name = updateData.name;
    // Commmented out because these columns do not exist in the 'shops' table yet
    // if (updateData.location !== undefined) payload.location = updateData.location;
    // if (updateData.description !== undefined) payload.description = updateData.description;

    const { data, error } = await supabase
      .from('shops')
      .update(payload)
      .eq('id', shopId)
      .select()
      .single();

    if (error) {
      throw new InternalServerErrorException(
        `Failed to update shop: ${error.message}`,
      );
    }

    return data;
  }

  async ensurePermitsBucket() {
    await this.supabaseService.ensurePrivateBucket('permits');
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

    const reviewUrl = await this.supabaseService.createSignedStorageUrl(
      'permits',
      fileName,
      600,
    );
    if (!reviewUrl) {
      throw new InternalServerErrorException(
        'Failed to prepare permit for review',
      );
    }

    let aiSuggestion = 'DENY'; // Default to DENY to enforce ACCEPT/DENY binary
    let aiReasoning = 'Awaiting analysis...';

    try {
      if (!this.openai) {
        throw new Error('OPENAI_API_KEY is not configured');
      }
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
    } catch (error: any) {
      console.error('OpenAI Verification Error:', error);
      aiSuggestion = 'DENY'; // Must be strictly ACCEPT or DENY
      aiReasoning = `Failed to process document automatically: ${error.message}. Please review manually.`;
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
