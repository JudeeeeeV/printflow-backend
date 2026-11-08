import {
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  documentUploadError,
  DocumentUploadException,
} from './document-upload-error';

describe('safe document feedback', () => {
  it.each([
    ['UNSUPPORTED_FILE', 400],
    ['EMPTY_FILE', 400],
    ['FILE_TOO_LARGE', 413],
    ['UNREADABLE_FILE', 400],
    ['FILE_LIMIT_EXCEEDED', 413],
    ['CONVERSION_UNAVAILABLE', 503],
    ['UPLOAD_FAILED', 503],
    ['DRAFT_FILE_UNAVAILABLE', 400],
  ] as const)('returns actionable %s feedback', (code, status) => {
    const error = new DocumentUploadException(code);
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({
      code,
      field: 'file',
      message: expect.any(String) as unknown,
      nextStep: expect.any(String) as unknown,
    });
  });

  it.each([
    ['Encrypted PDF files are not supported', /password-protected/, /Unlock/],
    ['Encrypted DOCX files are not supported', /encrypted/, /protection/],
    [
      'File contents do not match the declared type',
      /do not match/,
      /extension/,
    ],
    [
      'The DOCX file could not be converted to a printable PDF',
      /DOCX/,
      /export a PDF/,
    ],
  ])(
    'recognizes only explicit validation evidence: %s',
    (message, problem, recovery) => {
      expect(
        documentUploadError(new BadRequestException(message)).getResponse(),
      ).toMatchObject({
        code: 'UNREADABLE_FILE',
        message: expect.stringMatching(problem) as unknown,
        nextStep: expect.stringMatching(recovery) as unknown,
      });
    },
  );

  it.each([
    ['PDF files may contain at most 1000 pages', '1000 pages'],
    ['DOCX files may contain at most 10000 entries', '10000 archive entries'],
    ['Images may contain at most 75000000 pixels', '75000000 pixels'],
    ['DOCX entries may expand to at most 134217728 bytes', '134217728 bytes'],
    ['DOCX files may expand to at most 268435456 bytes', '268435456 bytes'],
    ['Normalized PDFs may contain at most 104857600 bytes', '104857600 bytes'],
  ])('exposes an applicable public processing limit', (message, limit) => {
    expect(
      documentUploadError(new PayloadTooLargeException(message)).getResponse(),
    ).toMatchObject({
      code: 'FILE_LIMIT_EXCEEDED',
      message: expect.stringContaining(limit) as unknown,
    });
  });

  it.each([
    new Error('private command /server/document.docx'),
    new ServiceUnavailableException('private upstream response'),
    new PayloadTooLargeException('private archive path'),
    new BadRequestException('private parser stack'),
  ])('never copies an arbitrary upstream message', (error) => {
    const response = JSON.stringify(documentUploadError(error).getResponse());
    expect(response).not.toMatch(/private|\/server/);
    if (
      error instanceof ServiceUnavailableException ||
      !(
        error instanceof BadRequestException ||
        error instanceof PayloadTooLargeException
      )
    )
      expect(response).toContain('CONVERSION_UNAVAILABLE');
  });
});
