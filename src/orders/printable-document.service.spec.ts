import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { DOCX_MIME_TYPE } from '../common/upload-security';
import { PrintableDocumentService } from './printable-document.service';

const upload = (mimetype: string, buffer: Buffer) =>
  ({ mimetype, buffer }) as Express.Multer.File;

describe('PrintableDocumentService', () => {
  const service = new PrintableDocumentService();

  it('fits every PDF page to the selected paper size and preserves orientation', async () => {
    const source = await PDFDocument.create();
    const landscapeSource = source.addPage([1000, 500]);
    landscapeSource.drawRectangle({ x: 10, y: 10, width: 100, height: 50 });
    const portraitSource = source.addPage([500, 1000]);
    portraitSource.drawRectangle({ x: 10, y: 10, width: 50, height: 100 });
    const buffer = Buffer.from(await source.save());

    const result = await service.normalize(
      upload('application/pdf', buffer),
      'A4',
    );

    expect(result.pageCount).toBe(2);
    const normalized = await PDFDocument.load(result.buffer);
    const [landscape, portrait] = normalized.getPages();
    expect(landscape.getSize().width).toBeCloseTo(841.89, 1);
    expect(landscape.getSize().height).toBeCloseTo(595.28, 1);
    expect(portrait.getSize().width).toBeCloseTo(595.28, 1);
    expect(portrait.getSize().height).toBeCloseTo(841.89, 1);
  });

  it('converts a supported image into a one-page PDF', async () => {
    const image = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: '#0f62fe',
      },
    })
      .webp()
      .toBuffer();

    const result = await service.normalize(upload('image/webp', image), 'A4');
    const pdf = await PDFDocument.load(result.buffer);

    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(result.pageCount).toBe(1);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(841.89, 1);
    expect(pdf.getPage(0).getSize().height).toBeCloseTo(595.28, 1);
  });

  it('rejects a ZIP that is not a DOCX package', async () => {
    const archive = new JSZip();
    archive.file('unrelated.txt', 'not a word document');
    const buffer = await archive.generateAsync({ type: 'nodebuffer' });

    await expect(
      service.normalize(upload(DOCX_MIME_TYPE, buffer), 'A4'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a generous PDF limit but rejects more than 1,000 pages', async () => {
    const source = await PDFDocument.create();
    for (let page = 0; page < 1_000; page += 1) source.addPage([10, 10]);
    const accepted = await service.normalize(
      upload('application/pdf', Buffer.from(await source.save())),
      'A4',
    );
    expect(accepted.pageCount).toBe(1_000);

    source.addPage([10, 10]);

    await expect(
      service.normalize(
        upload('application/pdf', Buffer.from(await source.save())),
        'A4',
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
