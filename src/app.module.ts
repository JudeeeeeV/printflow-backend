import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './supabase/supabase.module';
import { IamModule } from './iam/iam.module';

@Module({
  imports: [SupabaseModule, IamModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
