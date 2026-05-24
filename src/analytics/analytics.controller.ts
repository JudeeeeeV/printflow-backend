import { Controller, Get, UseGuards, Query, Req, UnauthorizedException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { RolesGuard } from '../iam/guards/roles.guard';
import { Roles } from '../iam/decorators/roles.decorator';

@Controller('analytics')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get()
  @Roles('CLERK')
  async getAnalytics(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const user = req.user;
    if (!user || !user.id) {
      throw new UnauthorizedException(`User not found in request: ${JSON.stringify(user)}`);
    }

    // A user with role 'CLERK' uses their user ID as the shop ID in our current mapping
    const shopId = user.id;
    
    return this.analyticsService.getShopAnalytics(shopId, startDate, endDate);
  }
}
