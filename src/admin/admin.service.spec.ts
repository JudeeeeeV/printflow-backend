import { AdminService } from './admin.service';
import { SupabaseService } from '../supabase/supabase.service';
import { JwtService } from '@nestjs/jwt';

describe('AdminService', () => {
  it('should be defined', () => {
    const service = new AdminService({} as SupabaseService, {} as JwtService);
    expect(service).toBeDefined();
  });
});
