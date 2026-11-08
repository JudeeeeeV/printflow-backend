import { ValidationPipe } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SupabaseService } from '../supabase/supabase.service';

describe('account profile', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const validate = (value: unknown) => pipe.transform(value, { type: 'body', metatype: UpdateProfileDto });

  it('normalizes spaces while allowing compound names, apostrophes, and Unicode', async () => {
    expect(await validate({ firstName: '  María   Ana ', lastName: "De la Cruz-O'Neil" }))
      .toEqual({ firstName: 'María Ana', lastName: "De la Cruz-O'Neil" });
  });

  it.each([
    { firstName: '   ', lastName: 'Cruz' },
    { firstName: 'Ana', lastName: 'x'.repeat(101) },
    { firstName: 'Ana' },
    { firstName: 123, lastName: 'Cruz' },
    { firstName: 'Ana', lastName: 'Cruz', id: 'other-user' },
    { firstName: 'Ana', lastName: 'Cruz', role: 'MANAGER' },
  ])('rejects invalid or unauthorized profile fields: %j', async payload => {
    await expect(validate(payload)).rejects.toThrow();
  });

  it('reads and writes names for only the authenticated user', async () => {
    const query = {
      select: jest.fn().mockReturnThis(), update: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { first_name: 'Ana', last_name: 'Cruz' }, error: null }),
    };
    const service = new AuthService({ getAdminClient: () => ({ from: () => query }) } as unknown as SupabaseService);
    const controller = new AuthController(service, {} as never);
    const request = { user: { id: 'signed-in-user', role: 'STUDENT' } } as Parameters<AuthController['getProfile']>[0];
    expect(await controller.getProfile(request)).toEqual({ firstName: 'Ana', lastName: 'Cruz' });
    expect(await controller.updateProfile(request, { firstName: 'Ana', lastName: 'Cruz' })).toEqual({ firstName: 'Ana', lastName: 'Cruz' });
    expect(query.eq.mock.calls).toEqual([['id', 'signed-in-user'], ['id', 'signed-in-user']]);
    expect(query.update).toHaveBeenCalledWith({ first_name: 'Ana', last_name: 'Cruz' });
    query.single.mockResolvedValue({ data: null, error: { message: 'database error' } });
    await expect(service.updateProfile('signed-in-user', { firstName: 'Ana', lastName: 'Cruz' })).rejects.toThrow('Unable to save your name');
  });
});
