import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { ResendEmailOtpDto, VerifyEmailOtpDto } from './dto/email-otp.dto';
import { SignupVerificationService } from './signup-verification.service';
import { PasswordResetService } from './password-reset.service';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/password-reset.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly signupVerification: SignupVerificationService,
    private readonly passwordReset: PasswordResetService,
  ) { }

  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();
    // No Auth account, profile, shop, or password is stored before verification.
    await this.signupVerification.send(email);
    return { requiresEmailVerification: true, email };
  }

  async sendPasswordReset(email: string) {
    const cleanEmail = email.trim().toLowerCase();
    
    // Check if user exists
    const { data: user, error } = await this.supabaseService.getAdminClient()
      .from('users')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();

    if (error || !user) {
      // Don't leak whether the email exists or not
      return { message: 'If an account exists, a reset code has been sent.' };
    }

    await this.passwordReset.send(cleanEmail);
    return { message: 'If an account exists, a reset code has been sent.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    
    // 1. Verify the OTP
    await this.passwordReset.consume(email, dto.code);
    
    // 2. Find the user ID
    const { data: user, error: userError } = await this.supabaseService.getAdminClient()
      .from('users')
      .select('id')
      .eq('email', email)
      .single();

    if (userError || !user) {
      throw new BadRequestException('User not found.');
    }

    // 3. Update the password
    const { error: updateError } = await this.supabaseService.getAdminClient().auth.admin.updateUserById(
      user.id,
      { password: dto.password }
    );

    if (updateError) {
      throw new InternalServerErrorException('Failed to update password.');
    }

    return { success: true };
  }

  async verifyEmail(dto: VerifyEmailOtpDto) {
    const email = dto.email.trim().toLowerCase();
    // Atomic, one-time consumption must succeed before any account writes.
    await this.signupVerification.consume(email, dto.code);
    const { data, error } = await this.supabaseService.getAdminClient().auth.admin.createUser({
      email,
      password: dto.password,
      email_confirm: true,
      app_metadata: {
        signup_source: 'printflow_email_otp',
        signup_role: dto.accountType === 'Print Shop' ? 'CLERK' : 'STUDENT',
        ...(dto.accountType === 'Print Shop' ? { signup_shop_name: dto.shopName?.trim() } : {}),
      },
      user_metadata: {
        role: dto.accountType === 'Print Shop' ? 'CLERK' : 'STUDENT',
        ...(dto.accountType === 'Print Shop' ? { shop_name: dto.shopName?.trim() } : {}),
      },
    });
    if (error) {
      // Do not replace credentials or confirm an account from an earlier signup.
      throw new BadRequestException(error.message + ' If you already registered, sign in. Otherwise request a new code to retry.');
    }
    if (!data.user?.email_confirmed_at) {
      throw new InternalServerErrorException('Account creation could not be completed. Please try signing in or contact support.');
    }
    await this.provisionVerifiedSignup(data.user.id);
    return { verified: true };
  }

  private async provisionVerifiedSignup(userId: string) {
    const { error } = await this.supabaseService.getAdminClient().rpc('provision_verified_signup', { p_user_id: userId });
    if (error) {
      this.logger.error(`Verified account provisioning failed (database code: ${error.code}).`);
      throw new InternalServerErrorException('Your email is verified, but account setup could not finish. Try signing in again.');
    }
  }

  async resendCode({ email }: ResendEmailOtpDto) {
    await this.signupVerification.send(email.trim().toLowerCase());
    return { message: 'A new verification code has been sent. It expires in 10 minutes.' };
  }
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const supabase = this.supabaseService.getAdminClient();

    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError) throw new UnauthorizedException(authError.message);

    if (!authData.user.email_confirmed_at) {
      throw new UnauthorizedException('Verify your email before signing in.');
    }

    // Retry profile/shop setup if a previous verified signup was interrupted.
    if (authData.user.app_metadata?.signup_source === 'printflow_email_otp') {
      await this.provisionVerifiedSignup(authData.user.id);
    }

    // Signing in changes the auth client's session. Keep this trusted profile
    // lookup on a separate service-role client, as in SupabaseAuthGuard.
    const { data: users, error: userError } = await this.supabaseService.getAdminClient()
      .from('users')
      .select('role')
      .eq('id', authData.user.id);

    if (userError) {
      throw new InternalServerErrorException('Database access error.');
    }

    const userData = users && users.length > 0 ? users[0] : null;

    if (!userData) {
      throw new InternalServerErrorException(
        'Account profile found, but record is unreadable.',
      );
    }

    const frontendRoleTag =
      userData.role === 'CLERK' || userData.role === 'MANAGER'
        ? 'Print Shop'
        : 'Student';

    return {
      token: authData.session?.access_token || '',
      user: {
        id: authData.user.id,
        email: authData.user.email,
        roleTag: frontendRoleTag,
      },
    };
  }
}
