import { BadRequestException, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { degrees, PDFDocument, type PDFEmbeddedPage } from 'pdf-lib';
import sharp from 'sharp';
import { DOCX_MIME_TYPE } from '../common/upload-security';

const execFileAsync = promisify(execFile);
const OFFICE_TIMEOUT_MS = 120_000;
const PRINT_MARGIN_POINTS = 18;

const PAPER_SIZES: Record<string, [number, number]> = {
  SHORT: [612, 792],
  A4: [595.28, 841.89],
  LONG: [612, 1008],
};

export interface PrintableDocument {
  buffer: Buffer;
  pageCount: number;
}

@Injectable()
export class PrintableDocumentService {
  async normalize(
    file: Express.Multer.File,
    paperSize: string,
  ): Promise<PrintableDocument> {
    if (file.mimetype === 'application/pdf') {
      return this.fitPdfToPaper(
        file.buffer,
        paperSize,
        'The uploaded PDF is invalid',
      );
    }
    if (file.mimetype.startsWith('image/')) {
      return this.imageToPdf(file.buffer, paperSize);
    }
    if (file.mimetype === DOCX_MIME_TYPE) {
      return this.docxToPdf(file.buffer, paperSize);
    }
    throw new BadRequestException('Unsupported printable file type');
  }

  private async fitPdfToPaper(
    buffer: Buffer,
    paperSize: string,
    errorMessage: string,
  ): Promise<PrintableDocument> {
    try {
      const source = await PDFDocument.load(buffer);
      const sourcePages = source.getPages();
      const pageCount = sourcePages.length;
      if (pageCount < 1) throw new Error('PDF has no pages');

      const output = await PDFDocument.create();
      for (const sourcePage of sourcePages) {
        const rotation = this.normalizedRotation(
          sourcePage.getRotation().angle,
        );
        const rotated = rotation === 90 || rotation === 270;
        const sourceSize = sourcePage.getSize();
        const sourceWidth = rotated ? sourceSize.height : sourceSize.width;
        const sourceHeight = rotated ? sourceSize.width : sourceSize.height;
        const [pageWidth, pageHeight] = this.orientedPaperSize(
          paperSize,
          sourceWidth > sourceHeight,
        );
        const page = output.addPage([pageWidth, pageHeight]);
        if (!sourcePage.node.Contents()) continue;

        const embeddedPage = await output.embedPage(sourcePage);
        const availableWidth = pageWidth - PRINT_MARGIN_POINTS * 2;
        const availableHeight = pageHeight - PRINT_MARGIN_POINTS * 2;
        const scale = Math.min(
          availableWidth / sourceWidth,
          availableHeight / sourceHeight,
        );
        const drawnWidth = sourceWidth * scale;
        const drawnHeight = sourceHeight * scale;
        const x = (pageWidth - drawnWidth) / 2;
        const y = (pageHeight - drawnHeight) / 2;

        page.drawPage(embeddedPage, {
          ...this.rotatedPagePosition(embeddedPage, rotation, scale, x, y),
          width: embeddedPage.width * scale,
          height: embeddedPage.height * scale,
          rotate: degrees(rotation),
        });
      }

      return { buffer: Buffer.from(await output.save()), pageCount };
    } catch {
      throw new BadRequestException(errorMessage);
    }
  }

  private async imageToPdf(
    buffer: Buffer,
    paperSize: string,
  ): Promise<PrintableDocument> {
    try {
      const normalizedImage = sharp(buffer, {
        failOn: 'error',
        limitInputPixels: 100_000_000,
      }).rotate();
      const png = await normalizedImage.png().toBuffer();
      const pdf = await PDFDocument.create();
      const image = await pdf.embedPng(png);
      const [pageWidth, pageHeight] = this.orientedPaperSize(
        paperSize,
        image.width > image.height,
      );
      const page = pdf.addPage([pageWidth, pageHeight]);
      const availableWidth = pageWidth - PRINT_MARGIN_POINTS * 2;
      const availableHeight = pageHeight - PRINT_MARGIN_POINTS * 2;
      const scale = Math.min(
        availableWidth / image.width,
        availableHeight / image.height,
      );
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, {
        x: (pageWidth - width) / 2,
        y: (pageHeight - height) / 2,
        width,
        height,
      });

      return { buffer: Buffer.from(await pdf.save()), pageCount: 1 };
    } catch {
      throw new BadRequestException('The uploaded image is invalid');
    }
  }

  private async docxToPdf(
    buffer: Buffer,
    paperSize: string,
  ): Promise<PrintableDocument> {
    await this.assertDocxPackage(buffer);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'printflow-docx-'));
    const inputPath = join(workingDirectory, 'document.docx');
    const outputPath = join(workingDirectory, 'document.pdf');
    const profilePath = join(workingDirectory, 'libreoffice-profile');

    try {
      await writeFile(inputPath, buffer, { flag: 'wx' });
      const executable = await this.findLibreOffice();
      await execFileAsync(
        executable,
        [
          '--headless',
          `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
          '--convert-to',
          'pdf:writer_pdf_Export',
          '--outdir',
          workingDirectory,
          inputPath,
        ],
        {
          timeout: OFFICE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      const pdf = await readFile(outputPath);
      return this.fitPdfToPaper(
        pdf,
        paperSize,
        'The DOCX file could not be converted to a printable PDF',
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        'The DOCX file could not be converted to a printable PDF',
      );
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async assertDocxPackage(buffer: Buffer): Promise<void> {
    try {
      const archive = await JSZip.loadAsync(buffer, {
        createFolders: false,
      });
      if (
        !archive.file('[Content_Types].xml') ||
        !archive.file('word/document.xml')
      ) {
        throw new Error('Required DOCX entries are missing');
      }
    } catch {
      throw new BadRequestException('The uploaded DOCX file is invalid');
    }
  }

  private async findLibreOffice(): Promise<string> {
    const configured = process.env.LIBREOFFICE_PATH?.trim();
    const candidates = [
      configured,
      process.platform === 'win32'
        ? join(
            process.env.PROGRAMFILES || 'C:\\Program Files',
            'LibreOffice',
            'program',
            'soffice.exe',
          )
        : 'soffice',
      process.platform === 'win32'
        ? join(
            process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
            'LibreOffice',
            'program',
            'soffice.exe',
          )
        : 'libreoffice',
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      if (basename(candidate) === candidate && process.platform !== 'win32') {
        return candidate;
      }
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next known installation path.
      }
    }
    throw new Error('LibreOffice is not installed');
  }

  private orientedPaperSize(
    paperSize: string,
    landscape: boolean,
  ): [number, number] {
    const [width, height] = PAPER_SIZES[paperSize] || PAPER_SIZES.A4;
    return landscape ? [height, width] : [width, height];
  }

  private normalizedRotation(angle: number): 0 | 90 | 180 | 270 {
    const normalized = ((angle % 360) + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) {
      return normalized;
    }
    return 0;
  }

  private rotatedPagePosition(
    page: PDFEmbeddedPage,
    rotation: 0 | 90 | 180 | 270,
    scale: number,
    x: number,
    y: number,
  ): { x: number; y: number } {
    if (rotation === 90) return { x: x + page.height * scale, y };
    if (rotation === 180) {
      return { x: x + page.width * scale, y: y + page.height * scale };
    }
    if (rotation === 270) return { x, y: y + page.width * scale };
    return { x, y };
  }
}
