import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import * as bcrypt from 'bcrypt';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import { JwtService } from '@nestjs/jwt';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { TotpEncryptionService } from './totp-encryption.service';
import { createHash, randomUUID } from 'node:crypto';

@Injectable()
export class AdminService {
  constructor(
    private supabaseService: SupabaseService,
    private jwtService: JwtService,
    private daemonDevicesService: DaemonDevicesService,
    private totpEncryption: TotpEncryptionService,
  ) {}

  getDaemonDevices() {
    return this.daemonDevicesService.listAll();
  }

  revokeDaemonDevice(deviceId: string) {
    return this.daemonDevicesService.revokeAsAdmin(deviceId);
  }

  rescanDaemonDevice(deviceId: string) {
    return this.daemonDevicesService.requestPrinterRescanAsAdmin(deviceId);
  }

  async login(email: string, passwordPlain: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: admin, error } = await supabase
      .from('admins')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !admin) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(passwordPlain, admin.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Temporary token to be used for 2FA verification/setup
    const tempToken = this.jwtService.sign(
      { sub: admin.id, email: admin.email, tokenType: 'admin-temp' },
      { expiresIn: '15m' },
    );

    if (!admin.is_2fa_enabled) {
      // Generate setup
      const secret = speakeasy.generateSecret({
        name: `PrintFlow Admin (${email})`,
      });
      const otpauth = secret.otpauth_url;
      const qrCodeUrl = await qrcode.toDataURL(otpauth!);

      // Store the seed with application-level authenticated encryption.
      const { error: secretError } = await supabase
        .from('admins')
        .update({
          two_factor_secret: null,
          two_factor_secret_encrypted: this.totpEncryption.encrypt(
            secret.base32,
          ),
        })
        .eq('id', admin.id);
      if (secretError) {
        throw new InternalServerErrorException('Failed to initialize 2FA');
      }

      return {
        requires_setup: true,
        temp_token: tempToken,
        qr_code_url: qrCodeUrl,
        secret: secret.base32,
      };
    }

    return {
      requires_2fa: true,
      temp_token: tempToken,
    };
  }

  async setup2FA(adminId: string, token: string) {
    const supabase = this.supabaseService.getAdminClient();
    const { data: admin } = await supabase
      .from('admins')
      .select('*')
      .eq('id', adminId)
      .single();

    const secret = admin ? this.readTotpSecret(admin) : null;
    if (!admin || !secret) {
      throw new BadRequestException('Invalid state');
    }

    const isValid = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP token');
    }

    // Enable 2FA
    const { error: enableError } = await supabase
      .from('admins')
      .update({ is_2fa_enabled: true })
      .eq('id', adminId);
    if (enableError) {
      throw new InternalServerErrorException('Failed to enable 2FA');
    }

    // Issue full token
    const accessToken = await this.issueAccessToken(admin.id, admin.email);
    return { access_token: accessToken };
  }

  async verify2FA(adminId: string, token: string) {
    const supabase = this.supabaseService.getAdminClient();
    const { data: admin } = await supabase
      .from('admins')
      .select('*')
      .eq('id', adminId)
      .single();

    const secret = admin ? this.readTotpSecret(admin) : null;
    if (!admin || !secret || !admin.is_2fa_enabled) {
      throw new BadRequestException('Invalid state');
    }

    const isValid = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP token');
    }

    if (!admin.two_factor_secret_encrypted && admin.two_factor_secret) {
      const { error: migrationError } = await supabase
        .from('admins')
        .update({
          two_factor_secret: null,
          two_factor_secret_encrypted: this.totpEncryption.encrypt(secret),
        })
        .eq('id', admin.id);
      if (migrationError) {
        throw new InternalServerErrorException('Failed to secure 2FA settings');
      }
    }

    // Issue full token
    const accessToken = await this.issueAccessToken(admin.id, admin.email);
    return { access_token: accessToken };
  }

  private readTotpSecret(admin: {
    two_factor_secret?: string | null;
    two_factor_secret_encrypted?: string | null;
  }): string | null {
    if (admin.two_factor_secret_encrypted) {
      try {
        return this.totpEncryption.decrypt(admin.two_factor_secret_encrypted);
      } catch {
        throw new InternalServerErrorException('Unable to read 2FA settings');
      }
    }
    return admin.two_factor_secret || null;
  }

  async revokeSession(adminId: string, tokenId: string): Promise<void> {
    const tokenIdHash = createHash('sha256')
      .update(tokenId, 'utf8')
      .digest('hex');
    await this.supabaseService
      .getAdminClient()
      .from('admin_sessions')
      .update({ revoked_at: new Date().toISOString() })
      .eq('admin_id', adminId)
      .eq('token_id_hash', tokenIdHash);
  }

  private async issueAccessToken(
    adminId: string,
    email: string,
  ): Promise<string> {
    const tokenId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
    const { error } = await this.supabaseService
      .getAdminClient()
      .from('admin_sessions')
      .insert({
        admin_id: adminId,
        token_id_hash: createHash('sha256')
          .update(tokenId, 'utf8')
          .digest('hex'),
        expires_at: expiresAt,
      });
    if (error) {
      throw new InternalServerErrorException('Failed to create admin session');
    }
    return this.jwtService.sign({
      sub: adminId,
      email,
      role: 'ADMIN',
      tokenType: 'admin-access',
      jti: tokenId,
    });
  }

  async getPendingShops() {
    await this.supabaseService.ensurePrivateBucket('permits');
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('shops')
      .select('*')
      .eq('verification_status', 'PENDING_REVIEW');

    if (error) throw new InternalServerErrorException(error.message);
    return Promise.all(
      (data || []).map(async (shop: any) => ({
        ...shop,
        business_permit_url: await this.supabaseService.createSignedStorageUrl(
          'permits',
          shop.business_permit_url,
          300,
        ),
      })),
    );
  }

  async verifyShop(
    shopId: string,
    status: 'VERIFIED' | 'REJECTED',
    reason?: string,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('shops')
      .update({
        verification_status: status,
        ai_reasoning: reason || null, // overwrite with human reason if needed
      })
      .eq('id', shopId)
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    // If verified, maybe create a user for them? The shop owner already has a user account linked.
    return data;
  }

  async addAdmin(email: string, plainPassword: string) {
    const supabase = this.supabaseService.getAdminClient();
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    const { data, error } = await supabase
      .from('admins')
      .insert([{ email, password_hash: passwordHash, is_2fa_enabled: false }])
      .select();

    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException('Admin with this email already exists.');
      }
      throw new InternalServerErrorException(error.message);
    }

    return { message: 'Admin created successfully' };
  }

  async getDisputes() {
    await this.supabaseService.ensurePrivateBucket('receipts');
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*, shops(name), payment_receipts(*)')
      .eq('state', 'ESCALATED_DISPUTE')
      .order('created_at', { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);
    return Promise.all(
      (data || []).map(async (order: any) => ({
        ...order,
        payment_receipts: await Promise.all(
          (order.payment_receipts || []).map(async (receipt: any) => ({
            ...receipt,
            receipt_url: await this.supabaseService.createSignedStorageUrl(
              'receipts',
              receipt.receipt_url,
              300,
            ),
          })),
        ),
      })),
    );
  }

  async forceApproveOrder(orderId: string) {
    const supabase = this.supabaseService.getAdminClient();

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .update({
        state: 'IN_PRODUCTION',
        dispute_reason: null,
      })
      .eq('id', orderId)
      .eq('state', 'ESCALATED_DISPUTE')
      .select('id')
      .maybeSingle();

    if (orderError || !order)
      throw new InternalServerErrorException(
        'Order is not an active escalated dispute',
      );

    const { error: receiptError } = await supabase
      .from('payment_receipts')
      .update({ verified: true })
      .eq('order_id', orderId);

    if (receiptError)
      throw new InternalServerErrorException('Failed to verify receipt');

    return { message: 'Order force approved successfully.' };
  }

  async upholdRejection(orderId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .update({
        state: 'AWAITING_PAYMENT',
        dispute_reason: null,
        expires_at: expiresAt,
      })
      .eq('id', orderId)
      .eq('state', 'ESCALATED_DISPUTE')
      .select('id')
      .maybeSingle();

    if (orderError || !order)
      throw new InternalServerErrorException(
        'Order is not an active escalated dispute',
      );

    return { message: 'Rejection upheld. Expiration timer restarted.' };
  }
}
