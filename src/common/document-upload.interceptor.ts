import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  MAX_DOCUMENT_BYTES,
  PRINTABLE_DOCUMENT_MIME_TYPES,
  secureUploadOptions,
} from './upload-security';
import { DocumentUploadException } from './document-upload-error';

/** Maps multipart failures for order documents without changing receipt uploads. */
@Injectable()
export class DocumentUploadInterceptor extends FileInterceptor(
  'file',
  secureUploadOptions(PRINTABLE_DOCUMENT_MIME_TYPES, MAX_DOCUMENT_BYTES),
) {
  async intercept(context: ExecutionContext, next: CallHandler) {
    try {
      return await super.intercept(context, next);
    } catch (error) {
      if (error instanceof PayloadTooLargeException)
        throw new DocumentUploadException('FILE_TOO_LARGE');
      if (error instanceof BadRequestException) {
        throw new DocumentUploadException(
          error.message === 'Unsupported file type'
            ? 'UNSUPPORTED_FILE'
            : 'UNREADABLE_FILE',
        );
      }
      throw error;
    }
  }
}
