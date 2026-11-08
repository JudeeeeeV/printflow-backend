import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import JSZip from 'jszip';
import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDocument,
  PDFRawStream,
} from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { DOCX_MIME_TYPE } from '../common/upload-security';
import {
  PrintableDocumentService,
  type PrintOrientation,
} from './printable-document.service';

const upload = (mimetype: string, buffer: Buffer) =>
  ({ mimetype, buffer }) as Express.Multer.File;

const paperSizes: Array<[string, number, number]> = [
  ['A4', 595.28, 841.89],
  ['SHORT', 612, 792],
  ['LONG', 612, 1008],
];
const orientations: PrintOrientation[] = ['PORTRAIT', 'LANDSCAPE'];

// Inspect the actual drawing transform, not just the output page dimensions.
function drawingBounds(
  document: PDFDocument,
  index: number,
  width: number,
  height: number,
) {
  const page = document.getPage(index);
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents
          .asArray()
          .map((ref) => document.context.lookup(ref, PDFRawStream))
      : [contents as PDFRawStream];
  const commands = streams
    .map((stream) =>
      Buffer.from(decodePDFRawStream(stream).decode()).toString(),
    )
    .join('\n');
  let matrix = [1, 0, 0, 1, 0, 0];
  for (const match of commands.matchAll(
    /([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) cm/g,
  )) {
    const [a, b, c, d, e, f] = matrix;
    const [u, v, w, x, y, z] = match.slice(1).map(Number);
    matrix = [
      a * u + c * v,
      b * u + d * v,
      a * w + c * x,
      b * w + d * x,
      a * y + c * z + e,
      b * y + d * z + f,
    ];
  }
  const [a, b, c, d, e, f] = matrix;
  const points = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  for (const [x, y] of points) {
    expect(x).toBeGreaterThanOrEqual(18 - 0.01);
    expect(y).toBeGreaterThanOrEqual(18 - 0.01);
    expect(x).toBeLessThanOrEqual(page.getWidth() - 18 + 0.01);
    expect(y).toBeLessThanOrEqual(page.getHeight() - 18 + 0.01);
  }
  return matrix;
}

describe('PrintableDocumentService', () => {
  const service = new PrintableDocumentService();

  it('counts stored PDF pages without rewriting the document', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 800]).drawText('First page');
    source.addPage([800, 400]).drawText('Second page');
    const buffer = Buffer.from(await source.save());
    const original = Buffer.from(buffer);
    await expect(service.getPdfPageCount(buffer)).resolves.toBe(2);
    expect(buffer.equals(original)).toBe(true);
  });

  it('recognizes a PDF encryption marker using the installed parser', async () => {
    const source = await PDFDocument.create();
    source.addPage();
    source.context.trailerInfo.Encrypt = source.context.obj({
      Filter: 'Standard',
    });
    const buffer = Buffer.from(await source.save());
    await expect(service.getPdfPageCount(buffer)).rejects.toThrow(
      'Encrypted PDF files are not supported',
    );
    await expect(
      service.normalize(upload('application/pdf', buffer), 'A4'),
    ).rejects.toThrow('Encrypted PDF files are not supported');
  });

  it('rejects malformed and empty stored PDFs', async () => {
    await expect(
      service.getPdfPageCount(Buffer.from('not a PDF')),
    ).rejects.toBeInstanceOf(BadRequestException);
    const empty = await PDFDocument.create();
    await expect(
      service.getPdfPageCount(
        Buffer.from(await empty.save({ addDefaultPage: false })),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(paperSizes)(
    'fits upright and rotated mixed pages to either selected orientation on %s',
    async (size, width, height) => {
      const source = await PDFDocument.create();
      const sourceSizes = [
        [400, 800],
        [800, 400],
        [400, 800],
        [400, 800],
      ];
      sourceSizes.forEach(([w, h], index) => {
        const page = source.addPage([w, h]);
        page.drawRectangle({ x: 0, y: 0, width: w, height: h });
        if (index === 2) page.setRotation(degrees(90));
        if (index === 3) page.setRotation(degrees(270));
      });
      const buffer = Buffer.from(await source.save());
      for (const orientation of orientations) {
        const result = await service.normalize(
          upload('application/pdf', buffer),
          size,
          orientation,
        );
        const output = await PDFDocument.load(result.buffer);
        expect(result.pageCount).toBe(4);
        for (let index = 0; index < 4; index++) {
          const page = output.getPage(index);
          expect(page.getWidth()).toBeCloseTo(
            orientation === 'LANDSCAPE' ? height : width,
          );
          expect(page.getHeight()).toBeCloseTo(
            orientation === 'LANDSCAPE' ? width : height,
          );
          expect(page.getRotation().angle).toBe(0);
          const matrix = drawingBounds(
            output,
            index,
            ...(sourceSizes[index] as [number, number]),
          );
          expect(Math.hypot(matrix[0], matrix[1])).toBeCloseTo(
            Math.hypot(matrix[2], matrix[3]),
          );
          if (index < 2) {
            expect(matrix[1]).toBe(0);
            expect(matrix[2]).toBe(0);
            expect(matrix[0]).toBeGreaterThan(0);
            expect(matrix[3]).toBeGreaterThan(0);
          }
        }
      }
    },
  );

  it.each(paperSizes)(
    'fits portrait and landscape images upright to either orientation on %s',
    async (size, width, height) => {
      for (const [imageWidth, imageHeight] of [
        [80, 40],
        [40, 80],
      ]) {
        const image = await sharp({
          create: {
            width: imageWidth,
            height: imageHeight,
            channels: 3,
            background: '#fff',
          },
        })
          .png()
          .toBuffer();
        for (const orientation of orientations) {
          const result = await service.normalize(
            upload('image/png', image),
            size,
            orientation,
          );
          const output = await PDFDocument.load(result.buffer);
          expect(result.pageCount).toBe(1);
          expect(output.getPage(0).getWidth()).toBeCloseTo(
            orientation === 'LANDSCAPE' ? height : width,
          );
          expect(output.getPage(0).getHeight()).toBeCloseTo(
            orientation === 'LANDSCAPE' ? width : height,
          );
          const matrix = drawingBounds(output, 0, 1, 1);
          expect(matrix[1]).toBe(0);
          expect(matrix[2]).toBe(0);
          expect(matrix[0] / matrix[3]).toBeCloseTo(imageWidth / imageHeight);
        }
      }
    },
  );

  it('applies selected orientation after DOCX conversion', async () => {
    const converted = await PDFDocument.create();
    converted.addPage([400, 800]).drawText('Upright DOCX');
    const convertedBytes = await converted.save();
    const archive = new JSZip();
    archive.file('[Content_Types].xml', '<Types/>');
    archive.file('word/document.xml', '<document/>');
    const buffer = await archive.generateAsync({ type: 'nodebuffer' });
    const converter = service as unknown as {
      findLibreOffice: () => Promise<string>;
      runLibreOffice: (executable: string, args: string[]) => Promise<void>;
    };
    const find = jest
      .spyOn(converter, 'findLibreOffice')
      .mockResolvedValue('mock-office');
    const run = jest
      .spyOn(converter, 'runLibreOffice')
      .mockImplementation(async (_executable, args) => {
        await writeFile(
          join(args[args.indexOf('--outdir') + 1], 'document.pdf'),
          convertedBytes,
        );
      });
    try {
      for (const [size, width, height] of paperSizes)
        for (const orientation of orientations) {
          const result = await service.normalize(
            upload(DOCX_MIME_TYPE, buffer),
            size,
            orientation,
          );
          const output = await PDFDocument.load(result.buffer);
          expect(result.pageCount).toBe(1);
          expect(output.getPage(0).getWidth()).toBeCloseTo(
            orientation === 'LANDSCAPE' ? height : width,
          );
          expect(output.getPage(0).getHeight()).toBeCloseTo(
            orientation === 'LANDSCAPE' ? width : height,
          );
          const matrix = drawingBounds(output, 0, 400, 800);
          expect(matrix[1]).toBe(0);
          expect(matrix[2]).toBe(0);
        }
    } finally {
      find.mockRestore();
      run.mockRestore();
    }
  });

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

  it.each(['png', 'jpeg', 'webp'] as const)(
    'converts a supported %s image into a one-page PDF',
    async (format) => {
      const image = await sharp({
        create: {
          width: 40,
          height: 20,
          channels: 3,
          background: '#0f62fe',
        },
      })
        .toFormat(format)
        .toBuffer();

      const result = await service.normalize(
        upload(`image/${format}`, image),
        'A4',
      );
      const pdf = await PDFDocument.load(result.buffer);

      expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(result.pageCount).toBe(1);
      expect(pdf.getPageCount()).toBe(1);
      expect(pdf.getPage(0).getSize().width).toBeCloseTo(841.89, 1);
      expect(pdf.getPage(0).getSize().height).toBeCloseTo(595.28, 1);
    },
  );

  it('distinguishes excessive image dimensions from an unreadable file', async () => {
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    // Alter only the synthetic PNG header; no large allocation is needed.
    image.writeUInt32BE(100000, 16);
    image.writeUInt32BE(100000, 20);
    image.writeUInt32BE(crc32(image.subarray(12, 29)), 29);
    await expect(
      service.normalize(upload('image/png', image), 'A4'),
    ).rejects.toThrow(/^Images may contain at most \d+ pixels$/);
  });

  it.each(['LibreOffice is not installed', 'LibreOffice conversion timed out'])(
    'distinguishes converter unavailability: %s',
    async (message) => {
      const archive = new JSZip();
      archive.file('[Content_Types].xml', '<Types/>');
      archive.file('word/document.xml', '<document/>');
      const buffer = await archive.generateAsync({ type: 'nodebuffer' });
      const find = jest
        .spyOn(
          service as unknown as { findLibreOffice: () => Promise<string> },
          'findLibreOffice',
        )
        .mockRejectedValueOnce(new Error(message));
      try {
        await expect(
          service.normalize(upload(DOCX_MIME_TYPE, buffer), 'A4'),
        ).rejects.toBeInstanceOf(ServiceUnavailableException);
      } finally {
        find.mockRestore();
      }
    },
  );

  it('preserves detected DOCX protection rather than calling it corrupt', async () => {
    const archive = new JSZip();
    archive.file('[Content_Types].xml', '<Types/>');
    archive.file('word/document.xml', '<document/>');
    const buffer = await archive.generateAsync({ type: 'nodebuffer' });
    const directory = buffer.indexOf(Buffer.from('504b0102', 'hex'));
    buffer.writeUInt16LE(buffer.readUInt16LE(directory + 8) | 1, directory + 8);
    await expect(
      service.normalize(upload(DOCX_MIME_TYPE, buffer), 'A4'),
    ).rejects.toThrow('Encrypted DOCX files are not supported');
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
      service.getPdfPageCount(Buffer.from(await source.save())),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    await expect(
      service.normalize(
        upload('application/pdf', Buffer.from(await source.save())),
        'A4',
      ),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
