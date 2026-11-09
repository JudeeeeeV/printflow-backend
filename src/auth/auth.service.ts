import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import {
  isTemporaryAuthFailure,
  throwIfReadFailed,
} from '../common/upstream-failure';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async getProfile(userId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('users')
      .select('first_name, last_name')
      .eq('id', userId)
      .single();
    if (error || !data)
      throw new InternalServerErrorException('Unable to load your profile.');
    return { firstName: data.first_name || '', lastName: data.last_name || '' };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('users')
      .update({ first_name: dto.firstName, last_name: dto.lastName })
      .eq('id', userId)
      .select('first_name, last_name')
      .single();
    if (error || !data)
      throw new InternalServerErrorException(
        'Unable to save your name. Please try again.',
      );
    return { firstName: data.first_name, lastName: data.last_name };
  }

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const supabase = this.supabaseService.createSessionClient();

    let authResult;
    try {
      authResult = await supabase.auth.signInWithPassword({
        email,
        password,
      });
    } catch (error) {
      if (isAuthRetryableFetchError(error)) {
        throw new ServiceUnavailableException(
          'Sign-in service unavailable. Please try again.',
        );
      }
      throw error;
    }

    const { data: authData, error: authError } = authResult;

    if (isAuthRetryableFetchError(authError)) {
      throw new ServiceUnavailableException(
        'Sign-in service unavailable. Please try again.',
      );
    }
    if (authError) throw new UnauthorizedException('Invalid credentials');

    if (!authData.user.email_confirmed_at) {
      throw new UnauthorizedException('Verify your email before signing in.');
    }

    // Signing in changes the auth client's session. Keep this trusted profile
    // lookup on a separate service-role client, as in SupabaseAuthGuard.
    const { data: users, error: userError } = await this.supabaseService
      .getAdminClient()
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

    if (!authData.session?.access_token || !authData.session.refresh_token) {
      throw new UnauthorizedException('Unable to establish a session');
    }

    return {
      accessToken: authData.session.access_token,
      refreshToken: authData.session.refresh_token,
      expiresIn: authData.session.expires_in || 3600,
      user: {
        id: authData.user.id,
        email: authData.user.email,
        roleTag: frontendRoleTag,
      },
    };
  }

  private sessionServiceUnavailable() {
    return new ServiceUnavailableException(
      'Session service unavailable. Please try again.',
    );
  }

  async refresh(refreshToken: string) {
    const { data, error } = await this.supabaseService
      .createSessionClient()
      .auth.refreshSession({ refresh_token: refreshToken })
      .catch(() => {
        throw this.sessionServiceUnavailable();
      });
    if (isTemporaryAuthFailure(error)) throw this.sessionServiceUnavailable();
    if (
      error ||
      !data.session?.access_token ||
      !data.session.refresh_token ||
      !data.user
    ) {
      throw new UnauthorizedException('Session refresh failed');
    }
    const { data: profile, error: profileError } = await this.supabaseService
      .getAdminClient()
      .from('users')
      .select('role')
      .eq('id', data.user.id)
      .single();
    throwIfReadFailed(profileError);
    if (profileError || !profile) {
      throw new UnauthorizedException('User profile not found');
    }
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in || 3600,
      user: {
        id: data.user.id,
        email: data.user.email,
        roleTag:
          profile.role === 'CLERK' || profile.role === 'MANAGER'
            ? 'Print Shop'
            : 'Student',
      },
    };
  }

  async logout(accessToken?: string): Promise<void> {
    if (!accessToken) return;
    await this.supabaseService
      .getAdminClient()
      .auth.admin.signOut(accessToken, 'local')
      .catch(() => undefined);
  }
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const supabase = this.supabaseService.getAdminClient();

    // 1. Fetch user's email to verify current password via signIn
    const { data: user, error: userError } =
      await supabase.auth.admin.getUserById(userId);
    if (userError || !user.user?.email) {
      throw new InternalServerErrorException('User not found.');
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'Your new password cannot be the same as your old password.',
      );
    }

    // 2. Verify current password
    const { error: signInError } = await this.supabaseService
      .createSessionClient()
      .auth.signInWithPassword({
        email: user.user.email,
        password: dto.currentPassword,
      });

    if (signInError) {
      throw new BadRequestException('Incorrect current password.');
    }

    // 3. Update to new password
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      userId,
      { password: dto.newPassword },
    );

    if (updateError) {
      throw new InternalServerErrorException('Failed to update password.');
    }

    return { success: true, message: 'Password updated successfully.' };
  }
}
