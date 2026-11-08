import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';

export type DocumentErrorCode =
  | 'UNSUPPORTED_FILE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNREADABLE_FILE'
  | 'FILE_LIMIT_EXCEEDED'
  | 'CONVERSION_UNAVAILABLE'
  | 'UPLOAD_FAILED'
  | 'DRAFT_FILE_UNAVAILABLE';

const errors: Record<
  DocumentErrorCode,
  { status: number; message: string; nextStep: string }
> = {
  UNSUPPORTED_FILE: {
    status: 400,
    message: 'This file format is not supported.',
    nextStep: 'Choose a PDF, DOCX, PNG, JPG, or WEBP file.',
  },
  EMPTY_FILE: {
    status: 400,
    message: 'No file data was received.',
    nextStep: 'Choose a non-empty file and try again.',
  },
  FILE_TOO_LARGE: {
    status: 413,
    message: 'This file exceeds the 20 MB upload limit.',
    nextStep: 'Compress or export a smaller file, then select it again.',
  },
  UNREADABLE_FILE: {
    status: 400,
    message: 'This file could not be read as a printable document.',
    nextStep:
      'Open it in its original app and export a new PDF, or choose another file.',
  },
  FILE_LIMIT_EXCEEDED: {
    status: 413,
    message: 'This document exceeds a supported processing limit.',
    nextStep:
      'Reduce its pages, image dimensions, or document complexity and select it again.',
  },
  CONVERSION_UNAVAILABLE: {
    status: 503,
    message: 'Document processing is temporarily unavailable.',
    nextStep: 'Keep this file and try again shortly, or export it as a PDF.',
  },
  UPLOAD_FAILED: {
    status: 503,
    message: 'The file upload or attachment could not be completed.',
    nextStep:
      'Your order or draft may be incomplete. Check My Orders or Drafts before trying again.',
  },
  DRAFT_FILE_UNAVAILABLE: {
    status: 400,
    message: 'The saved draft file is missing or unavailable.',
    nextStep:
      'Remove the draft file and upload a replacement before submitting.',
  },
};

type Detail = 'signature' | 'protectedPdf' | 'protectedDocx' | 'conversion';
const details: Record<Detail, { message: string; nextStep: string }> = {
  signature: {
    message: 'The file contents do not match its declared format.',
    nextStep:
      'Export it again in a supported format; changing the filename extension is not enough.',
  },
  protectedPdf: {
    message: 'This PDF is password-protected.',
    nextStep: 'Unlock it and export an unprotected PDF, then select it again.',
  },
  protectedDocx: {
    message: 'This DOCX contains encrypted content.',
    nextStep:
      'Remove its protection and save a new DOCX, or export an unprotected PDF.',
  },
  conversion: {
    message: 'This DOCX could not be converted to a printable PDF.',
    nextStep:
      'Open it in Word or LibreOffice and export a PDF, then select that file.',
  },
};

const limitMessages = {
  pages: (n: number) => `This PDF exceeds the server limit of ${n} pages.`,
  entries: (n: number) =>
    `This DOCX exceeds the server limit of ${n} archive entries.`,
  pixels: (n: number) => `This image exceeds the server limit of ${n} pixels.`,
  entryBytes: (n: number) =>
    `An embedded DOCX item exceeds the expanded size limit of ${n} bytes.`,
  expandedBytes: (n: number) =>
    `This DOCX exceeds the expanded size limit of ${n} bytes.`,
  normalizedBytes: (n: number) =>
    `The printable PDF exceeds the server limit of ${n} bytes.`,
};
type PublicLimit = { kind: keyof typeof limitMessages; value: number };
const limitPatterns: Array<[PublicLimit['kind'], RegExp]> = [
  ['pages', /^PDF files may contain at most (\d+) pages$/],
  ['entries', /^DOCX files may contain at most (\d+) entries$/],
  ['pixels', /^Images may contain at most (\d+) pixels$/],
  ['entryBytes', /^DOCX entries may expand to at most (\d+) bytes$/],
  ['expandedBytes', /^DOCX files may expand to at most (\d+) bytes$/],
  ['normalizedBytes', /^Normalized PDFs may contain at most (\d+) bytes$/],
];

/** Only fixed public text and validated numeric limits enter this response. */
export class DocumentUploadException extends HttpException {
  constructor(code: DocumentErrorCode, detail?: Detail, limit?: PublicLimit) {
    const definition = errors[code];
    const body = {
      code,
      field: 'file',
      message: definition.message,
      nextStep: definition.nextStep,
      ...(detail ? details[detail] : {}),
    };
    if (
      limit !== undefined &&
      Number.isSafeInteger(limit.value) &&
      limit.value > 0 &&
      code === 'FILE_LIMIT_EXCEEDED'
    ) {
      body.message = limitMessages[limit.kind](limit.value);
    }
    super(body, definition.status);
  }
}

/** Document-preparation boundaries only; other upload consumers keep their errors. */
export function documentUploadError(error: unknown): DocumentUploadException {
  if (error instanceof DocumentUploadException) return error;
  if (error instanceof ServiceUnavailableException)
    return new DocumentUploadException('CONVERSION_UNAVAILABLE');
  if (error instanceof PayloadTooLargeException) {
    for (const [kind, pattern] of limitPatterns) {
      const match = pattern.exec(error.message);
      if (match)
        return new DocumentUploadException('FILE_LIMIT_EXCEEDED', undefined, {
          kind,
          value: Number(match[1]),
        });
    }
    return new DocumentUploadException('FILE_LIMIT_EXCEEDED');
  }
  if (error instanceof BadRequestException) {
    if (error.message === 'Encrypted PDF files are not supported')
      return new DocumentUploadException('UNREADABLE_FILE', 'protectedPdf');
    if (error.message === 'Encrypted DOCX files are not supported')
      return new DocumentUploadException('UNREADABLE_FILE', 'protectedDocx');
    if (error.message === 'File contents do not match the declared type')
      return new DocumentUploadException('UNREADABLE_FILE', 'signature');
    if (
      error.message ===
      'The DOCX file could not be converted to a printable PDF'
    )
      return new DocumentUploadException('UNREADABLE_FILE', 'conversion');
    return new DocumentUploadException('UNREADABLE_FILE');
  }
  return new DocumentUploadException('CONVERSION_UNAVAILABLE');
}
