import { PrintAssetService } from './print-asset.service';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintableDocumentService } from '../orders/printable-document.service';
import sharp from 'sharp';
import { degrees, PDFDocument } from 'pdf-lib';

function setup(buffer: Buffer, type: string) {
  const storage = {
    download: jest.fn(
      (): Promise<{
        data: Blob | null;
        error: { message: string } | null;
      }> =>
        Promise.resolve({
          data: new Blob([new Uint8Array(buffer)], { type }),
          error: null,
        }),
    ),
    upload: jest.fn((): Promise<{ error: { message: string } | null }> =>
      Promise.resolve({
        error: null,
      }),
    ),
  };
  const supabase = {
    storagePath: (value: string) => value,
    getAdminClient: () => ({ storage: { from: () => storage } }),
    createSignedStorageUrl: jest
      .fn()
      .mockResolvedValue('https://example.test/print.pdf'),
  };
  const documents = new PrintableDocumentService();
  return {
    documents,
    storage,
    supabase,
    service: new PrintAssetService(
      supabase as unknown as SupabaseService,
      documents,
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
    expect(calls[0][0]).toBe('print-ready/shop/order-A4-PORTRAIT.pdf');
    const document = await PDFDocument.load(calls[0][1]);
    expect(document.getPageCount()).toBe(1);
    expect(document.getPage(0).getWidth()).toBeCloseTo(595.28);
    expect(supabase.createSignedStorageUrl).toHaveBeenCalledWith(
      'assets',
      'print-ready/shop/order-A4-PORTRAIT.pdf',
      3600,
    );
  });

  it('inspects and reuses matching normalized PDFs without rewriting them', async () => {
    const source = await PDFDocument.create();
    source.addPage([595.28, 841.89]);
    const { service, storage, supabase } = setup(
      Buffer.from(await source.save()),
      'application/pdf',
    );
    await service.prepare('already-ready.pdf', 'shop', 'order', 'A4');
    expect(storage.download).toHaveBeenCalledWith('already-ready.pdf');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(supabase.createSignedStorageUrl).toHaveBeenCalledWith(
      'assets',
      'already-ready.pdf',
      3600,
    );
  });

  it.each(['PORTRAIT', 'LANDSCAPE'] as const)(
    'refits existing PDFs to %s without changing their original asset',
    async (orientation) => {
      const source = await PDFDocument.create();
      source.addPage([400, 800]).drawText('Original upright content');
      const buffer = Buffer.from(await source.save());
      const { service, storage, supabase, documents } = setup(
        buffer,
        'application/pdf',
      );
      const normalize = jest.spyOn(documents, 'normalize');
      for (let retry = 0; retry < 2; retry++) {
        await service.prepare(
          'original.pdf',
          'shop',
          'order',
          'A4',
          orientation,
        );
        const calls = storage.upload.mock.calls as [string, Buffer, unknown][];
        const output = await PDFDocument.load(calls[retry][1]);
        expect(output.getPage(0).getWidth()).toBeCloseTo(
          orientation === 'LANDSCAPE' ? 841.89 : 595.28,
        );
        expect(output.getPage(0).getHeight()).toBeCloseTo(
          orientation === 'LANDSCAPE' ? 595.28 : 841.89,
        );
        expect(output.getPageCount()).toBe(1);
        expect(calls[retry][0]).toBe(
          `print-ready/shop/order-A4-${orientation}.pdf`,
        );
        expect(calls[retry][2]).toEqual({
          contentType: 'application/pdf',
          upsert: true,
        });
      }
      expect(storage.download.mock.calls).toEqual([
        ['original.pdf'],
        ['original.pdf'],
      ]);
      const calls = storage.upload.mock.calls as [string, Buffer, unknown][];
      expect(normalize).toHaveBeenCalledTimes(2);
      for (const call of normalize.mock.calls)
        expect(call[0].buffer).toEqual(buffer);
      const first = await PDFDocument.load(calls[0][1]);
      const second = await PDFDocument.load(calls[1][1]);
      expect(first.getPage(0).getSize()).toEqual(second.getPage(0).getSize());
      expect(supabase.createSignedStorageUrl).toHaveBeenLastCalledWith(
        'assets',
        `print-ready/shop/order-A4-${orientation}.pdf`,
        3600,
      );
    },
  );

  it('refits all pages when a later page has a different shape or rotation', async () => {
    for (const rotated of [false, true]) {
      const source = await PDFDocument.create();
      source.addPage([595.28, 841.89]);
      const second = source.addPage(
        rotated ? [595.28, 841.89] : [841.89, 595.28],
      );
      second.drawText('Second page');
      if (rotated) second.setRotation(degrees(90));
      const { service, storage } = setup(
        Buffer.from(await source.save()),
        'application/pdf',
      );
      await service.prepare('mixed.pdf', 'shop', 'order', 'A4', 'PORTRAIT');
      const calls = storage.upload.mock.calls as [string, Buffer, unknown][];
      const output = await PDFDocument.load(calls[0][1]);
      expect(output.getPageCount()).toBe(2);
      for (const page of output.getPages()) {
        expect(page.getWidth()).toBeCloseTo(595.28);
        expect(page.getHeight()).toBeCloseTo(841.89);
        expect(page.getRotation().angle).toBe(0);
      }
    }
  });

  it('reuses a matching landscape PDF and refits a draft with a changed paper size', async () => {
    const source = await PDFDocument.create();
    source.addPage([841.89, 595.28]);
    const { service, storage } = setup(
      Buffer.from(await source.save()),
      'application/pdf',
    );
    await service.prepare('draft.pdf', 'shop', 'order', 'A4', 'LANDSCAPE');
    expect(storage.upload).not.toHaveBeenCalled();
    await service.prepare('draft.pdf', 'shop', 'order', 'LONG', 'PORTRAIT');
    const calls = storage.upload.mock.calls as [string, Buffer, unknown][];
    expect(calls[0][0]).toBe('print-ready/shop/order-LONG-PORTRAIT.pdf');
    const output = await PDFDocument.load(calls[0][1]);
    expect(output.getPage(0).getSize()).toEqual({ width: 612, height: 1008 });
  });

  it('does not sign or rewrite files after a download failure', async () => {
    const { service, storage, supabase } = setup(
      Buffer.alloc(0),
      'application/pdf',
    );
    storage.download.mockResolvedValue({
      data: null,
      error: { message: 'offline' },
    });
    await expect(
      service.prepare('missing.pdf', 'shop', 'order', 'A4'),
    ).rejects.toThrow('could not be downloaded');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(supabase.createSignedStorageUrl).not.toHaveBeenCalled();
  });

  it('preserves the original path and allows retry after derived upload failure', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 800]);
    const { service, storage, supabase } = setup(
      Buffer.from(await source.save()),
      'application/pdf',
    );
    storage.upload.mockResolvedValueOnce({ error: { message: 'offline' } });
    await expect(
      service.prepare('original.pdf', 'shop', 'order', 'A4', 'LANDSCAPE'),
    ).rejects.toThrow('could not be prepared');
    expect(supabase.createSignedStorageUrl).not.toHaveBeenCalled();
    await expect(
      service.prepare('original.pdf', 'shop', 'order', 'A4', 'LANDSCAPE'),
    ).resolves.toBe('https://example.test/print.pdf');
    expect(storage.download.mock.calls).toEqual([
      ['original.pdf'],
      ['original.pdf'],
    ]);
  });

  it('rejects broken and empty PDFs before signing or uploading', async () => {
    for (const buffer of [
      Buffer.from('%PDF-invalid'),
      Buffer.from(
        await (await PDFDocument.create()).save({ addDefaultPage: false }),
      ),
    ]) {
      const { service, storage, supabase } = setup(buffer, 'application/pdf');
      await expect(
        service.prepare('broken.pdf', 'shop', 'order', 'A4'),
      ).rejects.toThrow();
      expect(storage.upload).not.toHaveBeenCalled();
      expect(supabase.createSignedStorageUrl).not.toHaveBeenCalled();
    }
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
