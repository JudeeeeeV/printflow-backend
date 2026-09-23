import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import sharp from 'sharp';
import { MAX_SHOP_PHOTO_BYTES, normalizeShopPhoto } from './shop-photo';

const file = (buffer: Buffer, mimetype = 'image/png') =>
  ({ buffer, mimetype }) as Express.Multer.File;

describe('Shop photo normalization', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'decodes %s and stores a resized WebP without metadata',
    async (format) => {
      const source = await sharp({
        create: {
          width: 1800,
          height: 900,
          channels: 3,
          background: '#336699',
        },
      })
        .withMetadata()
        .toFormat(format)
        .toBuffer();
      const result = await normalizeShopPhoto(file(source, `image/${format}`));
      const metadata = await sharp(result).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.width).toBe(1600);
      expect(metadata.height).toBe(800);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    },
  );

  it('rejects SVG even with a forged PNG MIME type', async () => {
    await expect(
      normalizeShopPhoto(file(Buffer.from('<svg onload="alert(1)"></svg>'))),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects corrupted content with a valid header', async () => {
    await expect(
      normalizeShopPhoto(file(Buffer.from('89504e470d0a1a0a00000000', 'hex'))),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects large byte payloads', async () => {
    await expect(
      normalizeShopPhoto(file(Buffer.alloc(MAX_SHOP_PHOTO_BYTES + 1))),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('rejects decompression-heavy images over the pixel limit', async () => {
    const source = await sharp({
      create: { width: 5000, height: 4001, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    await expect(normalizeShopPhoto(file(source))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
