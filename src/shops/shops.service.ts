import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import OpenAI from 'openai';

@Injectable()
export class ShopsService {
  private openai: OpenAI;

  constructor(private supabaseService: SupabaseService) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async getVerifiedShops() {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select('*')
      .eq('status', 'OPEN')
      .eq('verification_status', 'VERIFIED');

    if (error) {
      throw new InternalServerErrorException(error.message);
    }
    return data;
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
    return data;
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
    const supabase = this.supabaseService.getAdminClient();
    const { data: buckets, error: listError } =
      await supabase.storage.listBuckets();

    if (listError) {
      console.error('Error listing buckets:', listError);
      throw new InternalServerErrorException(
        `Failed to list buckets: ${listError.message}`,
      );
    }

    if (!buckets?.find((b) => b.name === 'permits')) {
      console.log("Bucket 'permits' not found, creating it...");
      const { data, error: createError } = await supabase.storage.createBucket(
        'permits',
        { public: true },
      );
      if (createError) {
        console.error('Error creating bucket:', createError);
        throw new InternalServerErrorException(
          `Failed to create permits bucket: ${createError.message}`,
        );
      }
      console.log('Bucket created successfully:', data);
    }
  }

  async ensureGcashQrsBucket() {
    const supabase = this.supabaseService.getAdminClient();
    const { data: buckets, error: listError } =
      await supabase.storage.listBuckets();

    if (listError) {
      console.error('Error listing buckets:', listError);
      throw new InternalServerErrorException(
        `Failed to list buckets: ${listError.message}`,
      );
    }

    if (!buckets?.find((b) => b.name === 'gcash_qrs')) {
      console.log("Bucket 'gcash_qrs' not found, creating it...");
      const { data, error: createError } = await supabase.storage.createBucket(
        'gcash_qrs',
        { public: true },
      );
      if (createError) {
        console.error('Error creating bucket:', createError);
        throw new InternalServerErrorException(
          `Failed to create gcash_qrs bucket: ${createError.message}`,
        );
      }
      console.log('Bucket gcash_qrs created successfully:', data);
    }
  }

  async verifyPermit(shopId: string, file: Express.Multer.File) {
    await this.ensurePermitsBucket();
    const supabase = this.supabaseService.getAdminClient();

    const fileName = `${shopId}-${Date.now()}-${file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('permits')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload permit: ${uploadError.message}`,
      );
    }

    const { data: urlData } = supabase.storage
      .from('permits')
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;

    let aiSuggestion = 'DENY'; // Default to DENY to enforce ACCEPT/DENY binary
    let aiReasoning = 'Awaiting analysis...';

    try {
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
                  url: publicUrl,
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
        business_permit_url: publicUrl,
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

    return updateData;
  }

  async uploadGcashQr(shopId: string, file: Express.Multer.File) {
    await this.ensureGcashQrsBucket();
    const supabase = this.supabaseService.getAdminClient();

    const fileName = `${shopId}-${Date.now()}-${file.originalname}`;
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('gcash_qrs')
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
      });

    if (uploadError) {
      throw new InternalServerErrorException(
        `Failed to upload GCash QR: ${uploadError.message}`,
      );
    }

    const { data: urlData } = supabase.storage
      .from('gcash_qrs')
      .getPublicUrl(fileName);

    const publicUrl = urlData.publicUrl;

    const { data: updateData, error: updateError } = await supabase
      .from('shops')
      .update({
        gcash_qr_url: publicUrl,
      })
      .eq('id', shopId)
      .select()
      .single();

    if (updateError) {
      throw new InternalServerErrorException(
        `Failed to update GCash QR URL: ${updateError.message}`,
      );
    }

    return updateData;
  }
}
