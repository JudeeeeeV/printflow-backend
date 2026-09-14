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

@Injectable()
export class AdminService {
  constructor(
    private supabaseService: SupabaseService,
    private jwtService: JwtService,
  ) {}

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
      { sub: admin.id, email: admin.email, isTemp: true },
      { expiresIn: '15m' },
    );

    if (!admin.is_2fa_enabled) {
      // Generate setup
      const secret = speakeasy.generateSecret({
        name: `PrintFlow Admin (${email})`,
      });
      const otpauth = secret.otpauth_url;
      const qrCodeUrl = await qrcode.toDataURL(otpauth!);

      // Save secret temporarily in DB
      await supabase
        .from('admins')
        .update({ two_factor_secret: secret.base32 })
        .eq('id', admin.id);

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

    if (!admin || !admin.two_factor_secret) {
      throw new BadRequestException('Invalid state');
    }

    const isValid = speakeasy.totp.verify({
      secret: admin.two_factor_secret,
      encoding: 'base32',
      token,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP token');
    }

    // Enable 2FA
    await supabase
      .from('admins')
      .update({ is_2fa_enabled: true })
      .eq('id', adminId);

    // Issue full token
    const accessToken = this.jwtService.sign({
      sub: admin.id,
      email: admin.email,
      role: 'ADMIN',
    });
    return { access_token: accessToken };
  }

  async verify2FA(adminId: string, token: string) {
    const supabase = this.supabaseService.getAdminClient();
    const { data: admin } = await supabase
      .from('admins')
      .select('*')
      .eq('id', adminId)
      .single();

    if (!admin || !admin.two_factor_secret || !admin.is_2fa_enabled) {
      throw new BadRequestException('Invalid state');
    }

    const isValid = speakeasy.totp.verify({
      secret: admin.two_factor_secret,
      encoding: 'base32',
      token,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP token');
    }

    // Issue full token
    const accessToken = this.jwtService.sign({
      sub: admin.id,
      email: admin.email,
      role: 'ADMIN',
    });
    return { access_token: accessToken };
  }

  async getPendingShops() {
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('shops')
      .select('*')
      .eq('verification_status', 'PENDING_REVIEW');

    if (error) throw new InternalServerErrorException(error.message);
    return data;
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
    const supabase = this.supabaseService.getAdminClient();
    const { data, error } = await supabase
      .from('orders')
      .select('*, shops(name), payment_receipts(*)')
      .eq('state', 'ESCALATED_DISPUTE')
      .order('created_at', { ascending: false });

    if (error) throw new InternalServerErrorException(error.message);
    return data;
  }

  async forceApproveOrder(orderId: string) {
    const supabase = this.supabaseService.getAdminClient();

    // Set payment_receipts verified=true
    const { error: receiptError } = await supabase
      .from('payment_receipts')
      .update({ verified: true })
      .eq('order_id', orderId);

    if (receiptError)
      throw new InternalServerErrorException(
        'Failed to verify receipt: ' + receiptError.message,
      );

    // Update order state
    const { error: orderError } = await supabase
      .from('orders')
      .update({
        state: 'IN_PRODUCTION',
        dispute_reason: null,
      })
      .eq('id', orderId);

    if (orderError)
      throw new InternalServerErrorException(
        'Failed to update order state: ' + orderError.message,
      );

    return { message: 'Order force approved successfully.' };
  }

  async upholdRejection(orderId: string) {
    const supabase = this.supabaseService.getAdminClient();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { error: orderError } = await supabase
      .from('orders')
      .update({
        state: 'AWAITING_PAYMENT',
        dispute_reason: null,
        expires_at: expiresAt,
      })
      .eq('id', orderId);

    if (orderError)
      throw new InternalServerErrorException(
        'Failed to uphold rejection: ' + orderError.message,
      );

    return { message: 'Rejection upheld. Expiration timer restarted.' };
  }
}
