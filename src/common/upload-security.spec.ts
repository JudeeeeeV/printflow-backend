import { BadRequestException } from '@nestjs/common';
import {
  assertFileSignature,
  DOCX_MIME_TYPE,
  DOCUMENT_MIME_TYPES,
  PRINTABLE_DOCUMENT_MIME_TYPES,
  secureObjectName,
} from './upload-security';

const upload = (mimetype: string, buffer: Buffer) =>
  ({ mimetype, buffer }) as Express.Multer.File;

describe('upload security', () => {
  it('accepts a PDF only when its contents have a PDF signature', () => {
    expect(() =>
      assertFileSignature(
        upload('application/pdf', Buffer.from('%PDF-1.7\n')),
        DOCUMENT_MIME_TYPES,
      ),
    ).not.toThrow();

    expect(() =>
      assertFileSignature(
        upload('application/pdf', Buffer.from('<html>malicious</html>')),
        DOCUMENT_MIME_TYPES,
      ),
    ).toThrow(BadRequestException);
  });

  it('generates storage names without using an attacker-controlled filename', () => {
    const name = secureObjectName('user/order', 'application/pdf');
    expect(name).toMatch(/^user\/order\/[0-9a-f-]{36}\.pdf$/);
    expect(name).not.toContain('..');
  });

  it('allows DOCX only for printable order assets with a ZIP signature', () => {
    const docx = upload(DOCX_MIME_TYPE, Buffer.from('504b030414000000', 'hex'));

    expect(() =>
      assertFileSignature(docx, PRINTABLE_DOCUMENT_MIME_TYPES),
    ).not.toThrow();
    expect(() => assertFileSignature(docx, DOCUMENT_MIME_TYPES)).toThrow(
      BadRequestException,
    );
    expect(() =>
      assertFileSignature(
        upload(DOCX_MIME_TYPE, Buffer.from('not-a-zip')),
        PRINTABLE_DOCUMENT_MIME_TYPES,
      ),
    ).toThrow(BadRequestException);
  });
});
