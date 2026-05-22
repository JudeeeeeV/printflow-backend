import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class AssetUrlSigningService {
  constructor(private readonly configService: ConfigService) {}

  private get secretKey(): string {
    return this.configService.get<string>('JWT_SECRET') || 'fallback_secret_key';
  }

  /**
   * Generates a signed URL that expires after a set number of seconds
   */
  signUrl(assetUrl: string, expiresInSeconds: number = 3600): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const dataToSign = `${assetUrl}:${expiresAt}`;
    
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(dataToSign)
      .digest('hex');

    const signedUrl = new URL(assetUrl);
    signedUrl.searchParams.append('expires', expiresAt.toString());
    signedUrl.searchParams.append('sig', signature);

    return signedUrl.toString();
  }

  /**
   * Verifies a signed URL
   */
  verifySignature(urlWithSig: string): boolean {
    try {
      const url = new URL(urlWithSig);
      const expires = url.searchParams.get('expires');
      const sig = url.searchParams.get('sig');

      if (!expires || !sig) {
        return false;
      }

      if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
        return false; // Expired
      }

      url.searchParams.delete('expires');
      url.searchParams.delete('sig');
      const originalUrl = url.toString();

      const dataToSign = `${originalUrl}:${expires}`;
      const expectedSig = crypto
        .createHmac('sha256', this.secretKey)
        .update(dataToSign)
        .digest('hex');

      return sig === expectedSig;
    } catch (err) {
      return false;
    }
  }
}
