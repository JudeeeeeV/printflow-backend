import { Injectable, UnauthorizedException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
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