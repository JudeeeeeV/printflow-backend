import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.split(' ')[1];

    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret:
          process.env.JWT_SECRET || 'super_secret_admin_key_2026_printflow',
      });

      // We attach the user to the request object so our route handlers can use it.
      // E.g., req.user.sub = admin_id
      request['user'] = payload;

      // If the route expects a FULL token (role = ADMIN), and they pass a TEMP token (isTemp = true),
      // we should technically block them from non-auth routes.
      // But for simplicity, we allow the setup-2fa and verify-2fa to use the temp token.
      // Let's enforce that for /admin/shops and /admin/add, role MUST be ADMIN.
      const path = request.url;
      if (
        !path.includes('auth/setup-2fa') &&
        !path.includes('auth/verify-2fa')
      ) {
        if (payload.role !== 'ADMIN') {
          throw new UnauthorizedException(
            'Requires full 2FA authenticated token',
          );
        }
      }
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }
}
