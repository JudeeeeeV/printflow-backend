import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import {
  assertFileSignature,
  IMAGE_MIME_TYPES,
} from '../common/upload-security';

export const MAX_SHOP_PHOTO_BYTES = 5 * 1024 * 1024;
export const SHOP_PHOTO_BUCKET = 'shop_photos';

export async function normalizeShopPhoto(
  file: Express.Multer.File,
): Promise<Buffer> {
  if (file.buffer?.length > MAX_SHOP_PHOTO_BYTES) {
    throw new PayloadTooLargeException('Shop photos must be 5 MB or smaller.');
  }
  assertFileSignature(file, IMAGE_MIME_TYPES);
  try {
    // Decode, bound resource use, auto-orient, and re-encode. Original metadata
    // (including GPS/EXIF) and any appended file content are not retained.
    const input = sharp(file.buffer, {
      limitInputPixels: 20_000_000,
      failOn: 'warning',
    });
    const metadata = await input.metadata();
    if ((metadata.pages || 1) !== 1)
      throw new Error('Animated images are unsupported');
    return await input
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new BadRequestException(
      'Choose a valid, still JPEG, PNG or WebP photo of at most 20 megapixels.',
    );
  }
}
