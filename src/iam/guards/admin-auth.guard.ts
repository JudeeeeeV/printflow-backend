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
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_TEMP_COOKIE,
  bearerToken,
  readCookie,
} from '../../auth/auth-cookies';
import { createHash } from 'node:crypto';

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role?: 'ADMIN';
  tokenType: AdminTokenType;
  jti?: string;
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
    const requiredTokenType =
      this.reflector.getAllAndOverride<AdminTokenType>(ADMIN_TOKEN_TYPE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || 'admin-access';
    const token =
      bearerToken(request) ||
      readCookie(
        request,
        requiredTokenType === 'admin-temp'
          ? ADMIN_TEMP_COOKIE
          : ADMIN_ACCESS_COOKIE,
      );
    if (!token) throw new UnauthorizedException('Admin session is missing');

    try {
      const payload = await this.jwtService.verifyAsync<AdminJwtPayload>(
        token,
        {
          algorithms: ['HS256'],
          issuer: 'printflow-api',
          audience: 'printflow-admin',
        },
      );

      if (
        !payload.sub ||
        !payload.jti ||
        payload.tokenType !== requiredTokenType ||
        (requiredTokenType === 'admin-access' && payload.role !== 'ADMIN')
      ) {
        throw new UnauthorizedException('Invalid admin token type');
      }

      {
        const tokenIdHash = createHash('sha256')
          .update(payload.jti!, 'utf8')
          .digest('hex');
        const { data: session, error: sessionError } =
          await this.supabaseService
            .getAdminClient()
            .from(
              requiredTokenType === 'admin-access'
                ? 'admin_sessions'
                : 'admin_login_challenges',
            )
            .select(
              requiredTokenType === 'admin-access' ? 'id' : 'token_id_hash',
            )
            .eq('admin_id', payload.sub)
            .eq('token_id_hash', tokenIdHash)
            .is(
              requiredTokenType === 'admin-access'
                ? 'revoked_at'
                : 'consumed_at',
              null,
            )
            .gt('expires_at', new Date().toISOString())
            .maybeSingle();
        if (sessionError || !session) {
          throw new UnauthorizedException('Admin session is no longer active');
        }
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
