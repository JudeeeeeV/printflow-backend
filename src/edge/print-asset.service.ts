import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintableDocumentService } from '../orders/printable-document.service';
import {
  assertFileSignature,
  DOCX_MIME_TYPE,
  MAX_DOCUMENT_BYTES,
  PRINTABLE_DOCUMENT_MIME_TYPES,
} from '../common/upload-security';

@Injectable()
export class PrintAssetService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly documents: PrintableDocumentService,
  ) {}

  async prepare(
    assetUrl: string,
    shopId: string,
    orderId: string,
    paperSize: string,
  ) {
    const sourcePath = this.supabase.storagePath(assetUrl, 'assets');
    if (!sourcePath)
      throw new BadRequestException('The print file is unavailable');
    let printPath = sourcePath;
    if (!sourcePath.toLowerCase().endsWith('.pdf')) {
      const storage = this.supabase.getAdminClient().storage.from('assets');
      const { data: blob, error } = await storage.download(sourcePath);
      if (error || !blob)
        throw new BadRequestException(
          'The original print file could not be downloaded',
        );
      if (blob.size > MAX_DOCUMENT_BYTES)
        throw new BadRequestException('The original print file is too large');
      const buffer = Buffer.from(await blob.arrayBuffer());
      const extension = sourcePath.split('.').pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        docx: DOCX_MIME_TYPE,
      };
      const mimetype = mimeTypes[extension || ''] || blob.type;
      const file = { buffer, mimetype } as Express.Multer.File;
      assertFileSignature(file, PRINTABLE_DOCUMENT_MIME_TYPES);
      const printable = await this.documents.normalize(file, paperSize);
      // Preserve the original asset; reuse the derived PDF path on retries.
      printPath = `print-ready/${shopId}/${orderId}.pdf`;
      const { error: uploadError } = await storage.upload(
        printPath,
        printable.buffer,
        {
          contentType: 'application/pdf',
          upsert: true,
        },
      );
      if (uploadError)
        throw new BadRequestException(
          'The printable PDF could not be prepared. Please try again.',
        );
    }
    const url = await this.supabase.createSignedStorageUrl(
      'assets',
      printPath,
      3600,
    );
    if (!url) throw new BadRequestException('The printable PDF is unavailable');
    return url;
  }
}
