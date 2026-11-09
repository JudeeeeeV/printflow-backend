import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  isTemporaryAuthFailure,
  throwIfReadFailed,
} from '../../common/upstream-failure';
import { Request } from 'express';
import {
  bearerToken,
  readCookie,
  USER_ACCESS_COOKIE,
} from '../../auth/auth-cookies';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const queryToken =
      typeof request.query?.token === 'string' && request.query.token
        ? request.query.token
        : undefined;
    const token =
      bearerToken(request) ||
      readCookie(request, USER_ACCESS_COOKIE) ||
      queryToken;

    if (!token) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const supabase = this.supabaseService.getAdminClient();

    // Verify token with Supabase Auth
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (isTemporaryAuthFailure(error)) {
      throw new ServiceUnavailableException(
        'Sign-in service unavailable. Please try again.',
      );
    }
    if (error || !user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Fetch user's role from the public.users table
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    throwIfReadFailed(profileError);
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
