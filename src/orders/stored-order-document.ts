import { BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintableDocumentService } from './printable-document.service';

/** Call only after checking the actor's access to the order. */
export async function validateStoredOrderDocument(
  supabaseService: SupabaseService,
  documents: PrintableDocumentService,
  orderId: string,
): Promise<number> {
  const supabase = supabaseService.getAdminClient();
  const { data: asset, error } = await supabase.from('assets')
    .select('file_url, file_type').eq('order_id', orderId).limit(1).single();
  if (error || !asset || asset.file_type !== 'PDF') {
    throw new BadRequestException('A valid stored PDF is required before authorizing production.');
  }
  const path = supabaseService.storagePath(asset.file_url, 'assets');
  if (!path) throw new BadRequestException('The stored document path is invalid.');
  const { data: blob, error: downloadError } = await supabase.storage.from('assets').download(path);
  if (downloadError || !blob) throw new BadRequestException('The stored document is unavailable. Restore it before verifying payment.');
  try {
    return await documents.getPdfPageCount(Buffer.from(await blob.arrayBuffer()));
  } catch {
    throw new BadRequestException('The stored PDF is invalid. Replace it before verifying payment.');
  }
}
