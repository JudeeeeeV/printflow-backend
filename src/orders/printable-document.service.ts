import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { degrees, PDFDocument, type PDFEmbeddedPage } from 'pdf-lib';
import sharp from 'sharp';
import { DOCX_MIME_TYPE } from '../common/upload-security';

const execFileAsync = promisify(execFile);
const OFFICE_TIMEOUT_MS = 120_000;
const PRINT_MARGIN_POINTS = 18;
const MAX_PDF_PAGES = positiveInteger('MAX_PDF_PAGES', 1_000);
const MAX_IMAGE_PIXELS = positiveInteger('MAX_IMAGE_PIXELS', 75_000_000);
const MAX_DOCX_ENTRIES = positiveInteger('MAX_DOCX_ENTRIES', 10_000);
const MAX_DOCX_EXPANDED_BYTES = positiveInteger(
  'MAX_DOCX_EXPANDED_BYTES',
  256 * 1024 * 1024,
);
const MAX_DOCX_ENTRY_BYTES = positiveInteger(
  'MAX_DOCX_ENTRY_BYTES',
  128 * 1024 * 1024,
);
export const MAX_NORMALIZED_PDF_BYTES = positiveInteger(
  'MAX_NORMALIZED_PDF_BYTES',
  100 * 1024 * 1024,
);
const MAX_CONCURRENT_CONVERSIONS = positiveInteger(
  'MAX_CONCURRENT_CONVERSIONS',
  2,
);
const MAX_QUEUED_CONVERSIONS = positiveInteger('MAX_QUEUED_CONVERSIONS', 20);

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const PAPER_SIZES: Record<string, [number, number]> = {
  SHORT: [612, 792],
  A4: [595.28, 841.89],
  LONG: [612, 1008],
};

export type PrintOrientation = 'PORTRAIT' | 'LANDSCAPE';

export interface PrintableDocument {
  buffer: Buffer;
  pageCount: number;
}

@Injectable()
export class PrintableDocumentService {
  private activeConversions = 0;
  private readonly conversionWaiters: Array<() => void> = [];

  async normalize(
    file: Express.Multer.File,
    paperSize: string,
    orientation?: PrintOrientation,
  ): Promise<PrintableDocument> {
    return this.withConversionSlot(() =>
      this.normalizeWithinSlot(file, paperSize, orientation),
    );
  }

  async matchesPrintSettings(
    buffer: Buffer,
    paperSize: string,
    orientation: PrintOrientation,
  ): Promise<boolean> {
    return this.withConversionSlot(async () => {
      try {
        this.assertNormalizedSize(buffer);
        const source = await PDFDocument.load(buffer);
        const pages = source.getPages();
        if (pages.length < 1) throw new Error('PDF has no pages');
        if (pages.length > MAX_PDF_PAGES) {
          throw new PayloadTooLargeException(
            `PDF files may contain at most ${MAX_PDF_PAGES} pages`,
          );
        }
        const [width, height] = this.orientedPaperSize(
          paperSize,
          orientation === 'LANDSCAPE',
        );
        return pages.every(
          (page) =>
            page.getRotation().angle === 0 &&
            Math.abs(page.getWidth() - width) < 0.01 &&
            Math.abs(page.getHeight() - height) < 0.01,
        );
      } catch (error) {
        if (error instanceof PayloadTooLargeException) throw error;
        throw new BadRequestException('The uploaded PDF is invalid');
      }
    });
  }

  private async normalizeWithinSlot(
    file: Express.Multer.File,
    paperSize: string,
    orientation?: PrintOrientation,
  ): Promise<PrintableDocument> {
    if (file.mimetype === 'application/pdf') {
      return this.fitPdfToPaper(
        file.buffer,
        paperSize,
        'The uploaded PDF is invalid',
        orientation,
      );
    }
    if (file.mimetype.startsWith('image/')) {
      return this.imageToPdf(file.buffer, paperSize, orientation);
    }
    if (file.mimetype === DOCX_MIME_TYPE) {
      return this.docxToPdf(file.buffer, paperSize, orientation);
    }
    throw new BadRequestException('Unsupported printable file type');
  }

  private async fitPdfToPaper(
    buffer: Buffer,
    paperSize: string,
    errorMessage: string,
    orientation?: PrintOrientation,
  ): Promise<PrintableDocument> {
    try {
      const source = await PDFDocument.load(buffer);
      const sourcePages = source.getPages();
      const pageCount = sourcePages.length;
      if (pageCount < 1) throw new Error('PDF has no pages');
      if (pageCount > MAX_PDF_PAGES) {
        throw new PayloadTooLargeException(
          `PDF files may contain at most ${MAX_PDF_PAGES} pages`,
        );
      }

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
          orientation
            ? orientation === 'LANDSCAPE'
            : sourceWidth > sourceHeight,
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

      const outputBuffer = Buffer.from(await output.save());
      this.assertNormalizedSize(outputBuffer);
      return { buffer: outputBuffer, pageCount };
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw error;
      throw new BadRequestException(errorMessage);
    }
  }

  private async imageToPdf(
    buffer: Buffer,
    paperSize: string,
    orientation?: PrintOrientation,
  ): Promise<PrintableDocument> {
    try {
      const normalizedImage = sharp(buffer, {
        failOn: 'error',
        limitInputPixels: MAX_IMAGE_PIXELS,
      }).rotate();
      const png = await normalizedImage.png().toBuffer();
      const pdf = await PDFDocument.create();
      const image = await pdf.embedPng(png);
      const [pageWidth, pageHeight] = this.orientedPaperSize(
        paperSize,
        orientation ? orientation === 'LANDSCAPE' : image.width > image.height,
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

      const outputBuffer = Buffer.from(await pdf.save());
      this.assertNormalizedSize(outputBuffer);
      return { buffer: outputBuffer, pageCount: 1 };
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw error;
      throw new BadRequestException('The uploaded image is invalid');
    }
  }

  private async docxToPdf(
    buffer: Buffer,
    paperSize: string,
    orientation?: PrintOrientation,
  ): Promise<PrintableDocument> {
    this.assertDocxPackage(buffer);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'printflow-docx-'));
    const inputPath = join(workingDirectory, 'document.docx');
    const outputPath = join(workingDirectory, 'document.pdf');
    const profilePath = join(workingDirectory, 'libreoffice-profile');

    try {
      await writeFile(inputPath, buffer, { flag: 'wx' });
      const executable = await this.findLibreOffice();
      await this.runLibreOffice(executable, [
        '--headless',
        '--nologo',
        '--nodefault',
        '--nolockcheck',
        '--norestore',
        `-env:UserInstallation=${pathToFileURL(profilePath).href}`,
        '--convert-to',
        'pdf:writer_pdf_Export',
        '--outdir',
        workingDirectory,
        inputPath,
      ]);
      const pdf = await readFile(outputPath);
      return this.fitPdfToPaper(
        pdf,
        paperSize,
        'The DOCX file could not be converted to a printable PDF',
        orientation,
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof PayloadTooLargeException
      ) {
        throw error;
      }
      throw new BadRequestException(
        'The DOCX file could not be converted to a printable PDF',
      );
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private assertDocxPackage(buffer: Buffer): void {
    try {
      const entries = this.inspectZipCentralDirectory(buffer);
      if (
        !entries.has('[Content_Types].xml') ||
        !entries.has('word/document.xml')
      ) {
        throw new Error('Required DOCX entries are missing');
      }
    } catch (error) {
      if (error instanceof PayloadTooLargeException) throw error;
      throw new BadRequestException('The uploaded DOCX file is invalid');
    }
  }

  private inspectZipCentralDirectory(buffer: Buffer): Set<string> {
    const minimumEocdLength = 22;
    const searchStart = Math.max(0, buffer.length - 65_557);
    let eocdOffset = -1;
    for (
      let offset = buffer.length - minimumEocdLength;
      offset >= searchStart;
      offset -= 1
    ) {
      if (buffer.readUInt32LE(offset) === 0x06054b50) {
        eocdOffset = offset;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error('ZIP directory is missing');

    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    const directorySize = buffer.readUInt32LE(eocdOffset + 12);
    const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
    if (
      entryCount === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff
    ) {
      throw new PayloadTooLargeException('ZIP64 DOCX files are not supported');
    }
    if (entryCount < 1 || entryCount > MAX_DOCX_ENTRIES) {
      throw new PayloadTooLargeException(
        `DOCX files may contain at most ${MAX_DOCX_ENTRIES} entries`,
      );
    }
    if (directoryOffset + directorySize > buffer.length) {
      throw new Error('ZIP directory is outside the uploaded file');
    }

    const names = new Set<string>();
    let totalExpandedBytes = 0;
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (
        offset + 46 > buffer.length ||
        buffer.readUInt32LE(offset) !== 0x02014b50
      ) {
        throw new Error('Invalid ZIP directory entry');
      }
      const flags = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const expandedSize = buffer.readUInt32LE(offset + 24);
      const fileNameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      if ((flags & 0x1) !== 0) {
        throw new BadRequestException('Encrypted DOCX files are not supported');
      }
      if (compressedSize === 0xffffffff || expandedSize === 0xffffffff) {
        throw new PayloadTooLargeException(
          'ZIP64 DOCX entries are not supported',
        );
      }
      if (expandedSize > MAX_DOCX_ENTRY_BYTES) {
        throw new PayloadTooLargeException('A DOCX entry is too large');
      }
      totalExpandedBytes += expandedSize;
      if (totalExpandedBytes > MAX_DOCX_EXPANDED_BYTES) {
        throw new PayloadTooLargeException(
          'The expanded DOCX file is too large',
        );
      }
      if (compressedSize > 0 && expandedSize / compressedSize > 500) {
        throw new PayloadTooLargeException(
          'The DOCX compression ratio is unsafe',
        );
      }

      const nameStart = offset + 46;
      const nameEnd = nameStart + fileNameLength;
      if (nameEnd > buffer.length) throw new Error('Invalid ZIP entry name');
      const name = buffer
        .subarray(nameStart, nameEnd)
        .toString('utf8')
        .replace(/\\/g, '/');
      if (name.startsWith('/') || name.split('/').includes('..')) {
        throw new BadRequestException('The DOCX contains an unsafe entry path');
      }
      names.add(name);
      offset = nameEnd + extraLength + commentLength;
    }
    return names;
  }

  private async runLibreOffice(
    executable: string,
    args: string[],
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errorOutput = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        if (errorOutput.length < 1024 * 1024) {
          errorOutput += chunk.toString('utf8');
        }
      });
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) {
          void execFileAsync(
            'taskkill.exe',
            ['/pid', String(child.pid), '/T', '/F'],
            { windowsHide: true },
          ).catch(() => child.kill('SIGKILL'));
        } else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
        reject(new Error('LibreOffice conversion timed out'));
      }, OFFICE_TIMEOUT_MS);
      timer.unref();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `LibreOffice exited with ${code ?? signal}: ${errorOutput.slice(0, 500)}`,
            ),
          );
        }
      });
    });
  }

  private assertNormalizedSize(buffer: Buffer): void {
    if (buffer.length > MAX_NORMALIZED_PDF_BYTES) {
      throw new PayloadTooLargeException('The normalized PDF is too large');
    }
  }

  private async withConversionSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeConversions >= MAX_CONCURRENT_CONVERSIONS) {
      if (this.conversionWaiters.length >= MAX_QUEUED_CONVERSIONS) {
        throw new ServiceUnavailableException(
          'Document conversion is busy. Please try again shortly.',
        );
      }
      await new Promise<void>((resolve) =>
        this.conversionWaiters.push(resolve),
      );
    }
    this.activeConversions += 1;
    try {
      return await work();
    } finally {
      this.activeConversions -= 1;
      this.conversionWaiters.shift()?.();
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
