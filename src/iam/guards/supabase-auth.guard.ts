import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { Request } from 'express';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.split(' ')[1];
    const supabase = this.supabaseService.getAdminClient();

    // Verify token with Supabase Auth
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Fetch user's role from the public.users table
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !userProfile) {
      throw new UnauthorizedException('User profile not found');
    }

    // Attach user payload and role to request
    request['user'] = {
      id: user.id,
      email: user.email,
      role: userProfile.role,
    };

    return true;
  }
}
