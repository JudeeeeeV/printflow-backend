// src/auth/rbac.middleware.ts
import {
  Injectable,
  NestMiddleware,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { JWTService } from './jwt.service';

// Mock Permissions Matrix as defined in the SDD
const PermissionsMatrix = {
  '/orders': ['STUDENT', 'CLERK', 'MANAGER'],
  '/orders/:id/receipt': ['STUDENT'],
};

@Injectable()
export class RBACMiddleware implements NestMiddleware {
  constructor(private readonly jwtService: JWTService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    const token = authHeader.split(' ')[1];
    const payload = this.jwtService.verifyToken(token);
    const userRole = this.jwtService.decodeRole(payload);

    // Attach user payload to the request for downstream controllers
    req['user'] = payload;

    // Simple path matching for the matrix
    const isAllowed = this.checkPermissions(req.baseUrl, userRole);
    if (!isAllowed) {
      // SDD Note: In a full implementation, trigger AuditLogger here
      throw new ForbiddenException(
        '403: Access Denied. Your role does not have permission.',
      );
    }

    next();
  }

  private checkPermissions(path: string, role: string): boolean {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const allowedRoles = PermissionsMatrix[path] || [];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return,@typescript-eslint/no-unsafe-call,@typescript-eslint/no-unsafe-member-access
    return allowedRoles.includes(role);
  }
}
