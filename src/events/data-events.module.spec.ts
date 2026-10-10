import { Test } from '@nestjs/testing';
import { DataEventsService } from './data-events.service';

describe('DataEventsModule dependency graph', () => {
  it('resolves the realtime controller guards in the application module', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: process.env.JWT_SECRET,
    };
    process.env.NODE_ENV = 'test';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.JWT_SECRET = 'test-jwt-secret-with-at-least-32-characters';

    try {
      const { AppModule } = jest.requireActual<typeof import('../app.module')>(
        '../app.module',
      );
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      expect(moduleRef.get(DataEventsService)).toBeInstanceOf(
        DataEventsService,
      );
      await moduleRef.close();
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('NODE_ENV', previous.nodeEnv);
      restore('SUPABASE_URL', previous.supabaseUrl);
      restore('SUPABASE_SERVICE_ROLE_KEY', previous.serviceRoleKey);
      restore('JWT_SECRET', previous.jwtSecret);
    }
  });
});
