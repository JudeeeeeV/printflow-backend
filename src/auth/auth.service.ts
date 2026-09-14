import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
  ) {}

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

    return {
      token: authData.session?.access_token || '',
      user: {
        id: authData.user.id,
        email: authData.user.email,
        roleTag: frontendRoleTag,
      },
    };
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
      throw new BadRequestException('Your new password cannot be the same as your old password.');
    }

    // 2. Verify current password
    const { error: signInError } = await supabase.auth.signInWithPassword({
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
