import { Controller, Req, Sse, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthGuard } from '../iam/guards/admin-auth.guard';
import { SupabaseAuthGuard } from '../iam/guards/supabase-auth.guard';
import { DataEventsService } from './data-events.service';

type UserRequest = Request & { user: { id: string; role: string } };

@Controller('events')
export class DataEventsController {
  constructor(private readonly events: DataEventsService) {}

  @Sse('user')
  @UseGuards(SupabaseAuthGuard)
  userEvents(@Req() request: UserRequest) {
    return this.events.forUser(request.user.id, request.user.role);
  }

  @Sse('admin')
  @UseGuards(AdminAuthGuard)
  adminEvents() {
    return this.events.forAdmin();
  }
}
