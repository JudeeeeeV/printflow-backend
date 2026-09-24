import { PrintAssetService } from './print-asset.service';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintableDocumentService } from '../orders/printable-document.service';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

function setup(buffer: Buffer, type: string) {
  const storage = {
    download: jest.fn().mockResolvedValue({
      data: new Blob([new Uint8Array(buffer)], { type }),
      error: null,
    }),
    upload: jest.fn().mockResolvedValue({ error: null }),
  };
  const supabase = {
    storagePath: (value: string) => value,
    getAdminClient: () => ({ storage: { from: () => storage } }),
    createSignedStorageUrl: jest
      .fn()
      .mockResolvedValue('https://example.test/print.pdf'),
  };
  return {
    storage,
    supabase,
    service: new PrintAssetService(
      supabase as unknown as SupabaseService,
      new PrintableDocumentService(),
    ),
  };
}

describe('PrintAssetService', () => {
  it('converts an older image order to a PDF before signing its download', async () => {
    const image = await sharp({
      create: { width: 20, height: 30, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const { service, storage, supabase } = setup(image, 'image/png');
    await expect(
      service.prepare('original.png', 'shop', 'order', 'A4'),
    ).resolves.toBe('https://example.test/print.pdf');
    const calls = storage.upload.mock.calls as [string, Buffer, unknown][];
    expect(calls[0][0]).toBe('print-ready/shop/order.pdf');
    const document = await PDFDocument.load(calls[0][1]);
    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getWidth()).toBeCloseTo(595.28);
    expect(supabase.createSignedStorageUrl).toHaveBeenCalledWith(
      'assets',
      'print-ready/shop/order.pdf',
      3600,
    );
  });

  it('uses existing normalized PDFs without downloading or rewriting them', async () => {
    const { service, storage, supabase } = setup(
      Buffer.alloc(0),
      'application/pdf',
    );
    await service.prepare('already-ready.pdf', 'shop', 'order', 'A4');
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(supabase.createSignedStorageUrl).toHaveBeenCalledWith(
      'assets',
      'already-ready.pdf',
      3600,
    );
  });

  it('rejects invalid source bytes rather than sending a non-PDF to the agent', async () => {
    const { service, storage } = setup(
      Buffer.from('not an image'),
      'image/png',
    );
    await expect(
      service.prepare('broken.png', 'shop', 'order', 'A4'),
    ).rejects.toThrow();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
