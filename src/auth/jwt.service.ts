import { Injectable, UnauthorizedException } from '@nestjs/common';

import { JwtService as NestJwtService } from '@nestjs/jwt';

export interface JwtPayload {
  userId: string;
  roleId: string;
}

@Injectable()
export class JWTService {
  constructor(private readonly nestJwtService: NestJwtService) {}

  verifyToken(token: string): JwtPayload {
    try {
      return this.nestJwtService.verify<JwtPayload>(token);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  decodeRole(payload: JwtPayload): string {
    return payload.roleId;
  }
}
