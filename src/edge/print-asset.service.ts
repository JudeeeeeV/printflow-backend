import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import {
  MAX_NORMALIZED_PDF_BYTES,
  PrintableDocumentService,
  type PrintOrientation,
} from '../orders/printable-document.service';
import {
  assertFileSignature,
  DOCX_MIME_TYPE,
  MAX_DOCUMENT_BYTES,
  PRINTABLE_DOCUMENT_MIME_TYPES,
} from '../common/upload-security';
import { MAX_PRINTABLE_PDF_BYTES } from '../orders/print-fulfillment';

/** The approved printable artifact a print attempt is pinned to. */
export interface PinnedPrintable {
  path: string;
  sha256: string;
  size: number;
}

const SIGNED_URL_SECONDS = 3600;

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
    orientation: PrintOrientation = 'PORTRAIT',
  ) {
    const printable = await this.preparePinned(
      assetUrl,
      shopId,
      orderId,
      paperSize,
      orientation,
    );
    return this.sign(printable.path);
  }

  /**
   * Builds (or reuses) the printable PDF and returns its identity. Converted
   * files are content-addressed, so preparing again never changes a file an
   * earlier attempt is pinned to.
   */
  async preparePinned(
    assetUrl: string,
    shopId: string,
    orderId: string,
    paperSize: string,
    orientation: PrintOrientation = 'PORTRAIT',
  ): Promise<PinnedPrintable> {
    const sourcePath = this.supabase.storagePath(assetUrl, 'assets');
    if (!sourcePath)
      throw new BadRequestException('The print file is unavailable');
    const isPdf = sourcePath.toLowerCase().endsWith('.pdf');
    const storage = this.supabase.getAdminClient().storage.from('assets');
    const { data: blob, error } = await storage.download(sourcePath);
    if (error || !blob)
      throw new BadRequestException(
        'The original print file could not be downloaded',
      );
    const sizeLimit = isPdf ? MAX_NORMALIZED_PDF_BYTES : MAX_DOCUMENT_BYTES;
    if (blob.size > sizeLimit)
      throw new BadRequestException('The original print file is too large');
    const buffer = Buffer.from(await blob.arrayBuffer());
    const extension = sourcePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      docx: DOCX_MIME_TYPE,
    };
    const mimetype = mimeTypes[extension || ''] || blob.type;
    const file = { buffer, mimetype } as Express.Multer.File;
    assertFileSignature(file, PRINTABLE_DOCUMENT_MIME_TYPES);
    const ready =
      isPdf &&
      (await this.documents.matchesPrintSettings(
        buffer,
        paperSize,
        orientation,
      ));
    if (ready) return this.pinned(sourcePath, buffer);

    const printable = await this.documents.normalize(
      file,
      paperSize,
      orientation,
    );
    const pinned = this.pinned('', printable.buffer);
    // Always derive from the stored asset, never a previous print-ready file.
    pinned.path = `print-ready/${shopId}/${orderId}-${paperSize}-${orientation}-${pinned.sha256.slice(0, 16)}.pdf`;
    const { error: uploadError } = await storage.upload(
      pinned.path,
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
    return pinned;
  }

  /** A short-lived download link for a pinned printable file. */
  async sign(path: string) {
    const url = await this.supabase.createSignedStorageUrl(
      'assets',
      path,
      SIGNED_URL_SECONDS,
    );
    if (!url) throw new BadRequestException('The printable PDF is unavailable');
    return url;
  }

  private pinned(path: string, buffer: Buffer): PinnedPrintable {
    // Reject what the agent cannot print before production is claimed.
    if (buffer.length > MAX_PRINTABLE_PDF_BYTES)
      throw new BadRequestException(
        'The printable PDF is larger than the printer agent supports (50 MB).',
      );
    return {
      path,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      size: buffer.length,
    };
  }
}
