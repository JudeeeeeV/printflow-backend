import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import type { Request } from 'express';

@Controller('iam')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class IamController {
  @Get('clerk-dashboard')
  @Roles('CLERK', 'MANAGER')
  getClerkData(@Req() req: Request) {
    // Explicit type casting to any to access custom user property safely
    return {
      message: 'Welcome to the Clerk Dashboard',
      user: (req as any).user,
    };
  }
}
