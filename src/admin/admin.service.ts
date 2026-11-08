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
import { applyOrderDecision } from '../orders/payment-workflow';

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

    const challengeId = randomUUID();
    const { error: challengeError } = await supabase
      .from('admin_login_challenges')
      .insert({
        admin_id: admin.id,
        token_id_hash: this.hashTokenId(challengeId),
        setup: !admin.is_2fa_enabled,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    if (challengeError)
      throw new InternalServerErrorException(
        'Failed to create login challenge',
      );
    const tempToken = this.jwtService.sign(
      {
        sub: admin.id,
        email: admin.email,
        tokenType: 'admin-temp',
        jti: challengeId,
      },
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
      const { data: secretSaved, error: secretError } = await supabase
        .from('admins')
        .update({
          two_factor_secret: null,
          two_factor_secret_encrypted: this.totpEncryption.encrypt(
            secret.base32,
          ),
        })
        .eq('id', admin.id)
        .eq('is_2fa_enabled', false)
        .select('id')
        .maybeSingle();
      if (secretError || !secretSaved) {
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

  setup2FA(adminId: string, token: string, challengeId: string) {
    return this.complete2FA(adminId, token, challengeId, true);
  }

  verify2FA(adminId: string, token: string, challengeId: string) {
    return this.complete2FA(adminId, token, challengeId, false);
  }

  private async complete2FA(
    adminId: string,
    token: string,
    challengeId: string,
    setup: boolean,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    if (!challengeId)
      throw new UnauthorizedException('Login challenge is missing');
    const challengeHash = this.hashTokenId(challengeId);
    const { data: reserved, error: reserveError } = await supabase.rpc(
      'reserve_admin_2fa_attempt',
      {
        p_admin_id: adminId,
        p_challenge_hash: challengeHash,
      },
    );
    if (reserveError)
      throw new InternalServerErrorException(
        'Failed to validate login challenge',
      );
    if (reserved !== true)
      throw new UnauthorizedException(
        'Login challenge expired, consumed, or locked. Sign in again.',
      );
    const { data: admin } = await supabase
      .from('admins')
      .select('*')
      .eq('id', adminId)
      .single();

    const secret = admin ? this.readTotpSecret(admin) : null;
    if (!admin || !secret || Boolean(admin.is_2fa_enabled) === setup) {
      throw new BadRequestException('Invalid state');
    }

    const time = Math.floor(Date.now() / 1000);
    const verified = speakeasy.totp.verifyDelta({
      secret,
      encoding: 'base32',
      token,
      window: 1,
      time,
    });
    if (!verified) {
      throw new UnauthorizedException('Invalid TOTP token');
    }

    const tokenId = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    // Sign before committing so a signing failure cannot consume a challenge.
    const accessToken = this.jwtService.sign({
      sub: admin.id,
      email: admin.email,
      role: 'ADMIN',
      tokenType: 'admin-access',
      jti: tokenId,
    });
    const { data: completed, error: completeError } = await supabase.rpc(
      'complete_admin_2fa',
      {
        p_admin_id: adminId,
        p_challenge_hash: challengeHash,
        p_totp_step: Math.floor(time / 30) + verified.delta,
        p_setup: setup,
        p_expected_secret:
          admin.two_factor_secret_encrypted || admin.two_factor_secret,
        p_encrypted_secret:
          admin.two_factor_secret_encrypted ||
          this.totpEncryption.encrypt(secret),
        p_session_hash: this.hashTokenId(tokenId),
        p_session_expires_at: expiresAt,
      },
    );
    if (completeError)
      throw new InternalServerErrorException('Failed to complete 2FA');
    if (completed !== true)
      throw new UnauthorizedException(
        'This code or login challenge was already used or changed. Sign in again.',
      );
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

  private hashTokenId(tokenId: string): string {
    return createHash('sha256').update(tokenId, 'utf8').digest('hex');
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
      .eq('payment_status', 'DISPUTED')
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

  async forceApproveOrder(
    orderId: string,
    adminId: string,
    receiptId: string,
    confirmed?: boolean,
  ) {
    const order = await applyOrderDecision(
      this.supabaseService,
      orderId,
      adminId,
      'ADMIN',
      'ADMIN_VERIFY',
      { receiptId, confirmed },
    );
    return {
      message: 'Payment verified. Eligible GCash orders are authorized for production.',
      state: order.state,
      order,
    };
  }

  async upholdRejection(
    orderId: string,
    adminId: string,
    receiptId: string,
    reason?: string,
  ) {
    const order = await applyOrderDecision(
      this.supabaseService,
      orderId,
      adminId,
      'ADMIN',
      'ADMIN_REJECT',
      { receiptId, reason },
    );
    return {
      message:
        'Receipt rejection upheld. Eligible orders receive a new retry deadline.',
      state: order.state,
      order,
    };
  }
}
