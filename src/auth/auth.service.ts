import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async register(registerDto: RegisterDto) {
    const { email, password, accountType } = registerDto;
    const supabase = this.supabaseService.getClient();

    // Ensure it matches the DB exactly
    const dbRole = accountType === 'Print Shop' ? 'CLERK' : 'STUDENT';

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role: dbRole, // MUST be uppercase 'STUDENT' or 'CLERK'
        },
      },
    });

    if (authError) {
      throw new BadRequestException(authError.message);
    }

    if (!authData.user) {
      throw new InternalServerErrorException('Failed to create user account');
    }

    // The database trigger handled it for us.

    return {
      token: authData.session?.access_token || '',
      user: {
        id: authData.user.id,
        email: authData.user.email,
        roleTag: accountType,
      },
    };
  }
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const supabase = this.supabaseService.getClient();

    const { data: authData, error: authError } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (authError) {
      throw new UnauthorizedException(authError.message);
    }

    if (!authData.user) {
      throw new InternalServerErrorException('Login failed: User data missing');
    }

    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', authData.user.id)
      .single();

    if (userError || !userData) {
      throw new InternalServerErrorException(
        'Login successful, but failed to retrieve user profile data.',
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
