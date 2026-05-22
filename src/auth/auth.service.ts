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
    const { email, password, accountType, shopName } = registerDto;
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

    // The database trigger handles inserting into `users` table
    
    // If it's a Print Shop, create a shop record linked to this user
    if (accountType === 'Print Shop' && shopName) {
      const { error: shopError } = await supabase.from('shops').insert({
        id: authData.user.id,
        name: shopName,
        status: 'OPEN',
        verification_status: 'UNVERIFIED',
      });
      if (shopError) {
        console.error('Failed to create shop record:', shopError);
      }
    }

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

    if (authError) throw new UnauthorizedException(authError.message);

    // --- DEBUGGING BLOCK ---
    console.log('Searching for User ID:', authData.user.id);

    const { data: users, error: userError } = await supabase
      .from('users')
      .select('role')
      .eq('id', authData.user.id);

    console.log('Query result:', users);
    console.log('Query error:', userError);

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
