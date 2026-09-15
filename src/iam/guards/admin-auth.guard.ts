import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  ADMIN_TOKEN_TYPE_KEY,
  AdminTokenType,
} from '../decorators/admin-token.decorator';
import type { Request } from 'express';

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role?: 'ADMIN';
  tokenType: AdminTokenType;
}

interface AdminRequest extends Request {
  user?: AdminJwtPayload;
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly supabaseService: SupabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.split(' ')[1];

    try {
      const payload = await this.jwtService.verifyAsync<AdminJwtPayload>(
        token,
        {
          algorithms: ['HS256'],
          issuer: 'printflow-api',
          audience: 'printflow-admin',
        },
      );

      const requiredTokenType =
        this.reflector.getAllAndOverride<AdminTokenType>(ADMIN_TOKEN_TYPE_KEY, [
          context.getHandler(),
          context.getClass(),
        ]) || 'admin-access';

      if (
        !payload.sub ||
        payload.tokenType !== requiredTokenType ||
        (requiredTokenType === 'admin-access' && payload.role !== 'ADMIN')
      ) {
        throw new UnauthorizedException('Invalid admin token type');
      }

      const { data: admin, error } = await this.supabaseService
        .getAdminClient()
        .from('admins')
        .select('id, email, is_2fa_enabled')
        .eq('id', payload.sub)
        .single();

      if (
        error ||
        !admin ||
        admin.email !== payload.email ||
        (requiredTokenType === 'admin-access' && !admin.is_2fa_enabled)
      ) {
        throw new UnauthorizedException('Admin account is not active');
      }

      request.user = payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }
}
