import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export function secureUploadOptions(
  allowedMimeTypes: readonly string[],
  fileSize: number,
) {
  return {
    limits: { fileSize, files: 1, fields: 10 },
    fileFilter: (
      _request: unknown,
      file: Express.Multer.File,
      callback: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      if (!allowedMimeTypes.includes(file.mimetype)) {
        callback(new BadRequestException('Unsupported file type'), false);
        return;
      }
      callback(null, true);
    },
  };
}

export function assertFileSignature(
  file: Express.Multer.File,
  allowedMimeTypes: readonly string[],
): void {
  if (!allowedMimeTypes.includes(file.mimetype) || !file.buffer?.length) {
    throw new BadRequestException('Invalid upload');
  }

  const bytes = file.buffer;
  const valid =
    (file.mimetype === 'application/pdf' &&
      bytes.subarray(0, 5).toString('ascii') === '%PDF-') ||
    (file.mimetype === 'image/png' &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
    (file.mimetype === 'image/jpeg' &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (file.mimetype === 'image/webp' &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP');

  if (!valid) {
    throw new BadRequestException(
      'File contents do not match the declared type',
    );
  }
}

export function secureObjectName(prefix: string, mimetype: string): string {
  const extension: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return `${prefix}/${randomUUID()}.${extension[mimetype]}`;
}
