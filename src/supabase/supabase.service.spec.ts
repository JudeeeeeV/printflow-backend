import { ConfigService } from '@nestjs/config';
import { SupabaseService } from './supabase.service';
import type { SupabaseClient } from '@supabase/supabase-js';

describe('batch storage URL signing', () => {
  function fixture() {
    const service = new SupabaseService(
      new ConfigService({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      }),
    );
    const createSignedUrls = jest.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({
        path,
        signedUrl: `signed:${path}`,
        error: null as string | null,
      })),
      error: null,
    }));
    const from = jest.fn().mockReturnValue({ createSignedUrls });
    jest
      .spyOn(service, 'getAdminClient')
      .mockReturnValue({ storage: { from } } as unknown as SupabaseClient);
    return { service, createSignedUrls, from };
  }

  it('signs 80 distinct files in one request and deduplicates repeated paths', async () => {
    const f = fixture();
    const paths = Array.from({ length: 80 }, (_, i) => `order-${i}/file.pdf`);
    const result = await f.service.createSignedStorageUrls('assets', [
      ...paths,
      paths[0],
      null,
    ]);
    expect(f.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(f.createSignedUrls).toHaveBeenCalledWith(paths, 300);
    expect(result.get(paths[0])).toBe(`signed:${paths[0]}`);
  });

  it('handles legacy URLs, missing objects, and invalid URLs without exposing raw paths', async () => {
    const f = fixture();
    f.createSignedUrls.mockResolvedValue({
      data: [
        { path: 'ok.pdf', signedUrl: 'signed:ok.pdf', error: null },
        { path: 'missing.pdf', signedUrl: '', error: 'missing' },
      ],
      error: null,
    });
    const legacy =
      'https://example.supabase.co/storage/v1/object/public/assets/ok.pdf';
    const result = await f.service.createSignedStorageUrls('assets', [
      legacy,
      'missing.pdf',
      'https://invalid.test/file',
    ]);
    expect(result.get(legacy)).toBe('signed:ok.pdf');
    expect(result.get('missing.pdf')).toBeNull();
    expect(result.get('https://invalid.test/file')).toBeNull();
  });

  it('bounds request size and skips empty buckets', async () => {
    const f = fixture();
    await f.service.createSignedStorageUrls('receipts', []);
    expect(f.from).not.toHaveBeenCalled();
    await f.service.createSignedStorageUrls(
      'assets',
      Array.from({ length: 205 }, (_, i) => `${i}.pdf`),
    );
    expect(f.createSignedUrls.mock.calls.map((call) => call[0].length)).toEqual(
      [100, 100, 5],
    );
  });
});

describe('SupabaseService', () => {
  it('should be defined', () => {
    const service = new SupabaseService(
      new ConfigService({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    );
    expect(service).toBeDefined();
  });

  it('reuses one Supabase client for all requests', () => {
    const service = new SupabaseService(
      new ConfigService({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    );
    expect(service.getAdminClient()).toBe(service.getClient());
    expect(service.getAdminClient()).toBe(service.getAdminClient());
  });

  it('isolates user sessions from the shared service-role client', () => {
    const service = new SupabaseService(
      new ConfigService({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    );
    const admin = service.getAdminClient();
    const session = service.createSessionClient();

    expect(session).not.toBe(admin);
    expect(service.getAdminClient()).toBe(admin);
  });

  it('checks startup buckets once and secures them concurrently', async () => {
    const service = new SupabaseService(
      new ConfigService({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      }),
    );
    const listBuckets = jest.fn().mockResolvedValue({
      data: [{ name: 'assets', public: true }],
      error: null,
    });
    const createBucket = jest.fn().mockResolvedValue({ error: null });
    const updateBucket = jest.fn().mockResolvedValue({ error: null });
    jest.spyOn(service, 'getAdminClient').mockReturnValue({
      storage: { listBuckets, createBucket, updateBucket },
    } as unknown as SupabaseClient);

    await service.onModuleInit();
    await service.ensurePrivateBucket('assets');

    expect(listBuckets).toHaveBeenCalledTimes(1);
    expect(updateBucket).toHaveBeenCalledWith('assets', { public: false });
    expect(createBucket).toHaveBeenCalledTimes(4);
  });
});
