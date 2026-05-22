import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    SupabaseModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_admin_key_2026_printflow',
      signOptions: { expiresIn: '8h' },
    })
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
