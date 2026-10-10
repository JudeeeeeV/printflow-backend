import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private supabase: SupabaseClient;
  private readonly securedBuckets = new Set<string>();
  private readonly bucketRequests = new Map<string, Promise<void>>();

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    if (!supabaseUrl || !supabaseKey) {
      this.logger.error(
        'Supabase URL or Key is missing from environment variables.',
      );
    } else {
      this.supabase = createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  getAdminClient(): SupabaseClient {
    return this.supabase;
  }

  /**
   * Creates an isolated client for operations that establish a user session.
   * Supabase auth methods such as signInWithPassword and refreshSession mutate
   * the client's Authorization header. They must never run on the shared
   * service-role client or later privileged database requests will execute as
   * that user instead of service_role.
   */
  createSessionClient(): SupabaseClient {
    return createClient(
      this.configService.get<string>('SUPABASE_URL')!,
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY')!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  async onModuleInit(): Promise<void> {
    await this.ensurePrivateBuckets([
      'assets',
      'receipts',
      'permits',
      'gcash_qrs',
      'agent-releases',
    ]);
  }

  async ensurePrivateBucket(bucket: string): Promise<void> {
    if (this.securedBuckets.has(bucket)) return;
    const pending = this.bucketRequests.get(bucket);
    if (pending) return pending;

    const request = this.ensurePrivateBuckets([bucket]).finally(() => {
      this.bucketRequests.delete(bucket);
    });
    this.bucketRequests.set(bucket, request);
    return request;
  }

  private async ensurePrivateBuckets(buckets: string[]): Promise<void> {
    const requested = [...new Set(buckets)].filter(
      (bucket) => !this.securedBuckets.has(bucket),
    );
    if (!requested.length) return;

    const client = this.getAdminClient();
    const { data: existingBuckets, error: listError } =
      await client.storage.listBuckets();
    if (listError) {
      throw new InternalServerErrorException(
        'Failed to inspect private storage buckets',
      );
    }

    const existing = new Map(
      (existingBuckets || []).map((candidate) => [candidate.name, candidate]),
    );
    await Promise.all(
      requested.map(async (bucket) => {
        const candidate = existing.get(bucket);
        const { error } = !candidate
          ? await client.storage.createBucket(bucket, { public: false })
          : candidate.public
            ? await client.storage.updateBucket(bucket, { public: false })
            : { error: null };
        if (error) {
          throw new InternalServerErrorException(
            `Failed to secure storage bucket ${bucket}`,
          );
        }
        this.securedBuckets.add(bucket);
      }),
    );
  }

  storagePath(value: string, bucket: string): string {
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) return value.replace(/^\/+/, '');

    try {
      const url = new URL(value);
      const markers = [
        `/storage/v1/object/public/${bucket}/`,
        `/storage/v1/object/sign/${bucket}/`,
      ];
      const marker = markers.find((candidate) =>
        url.pathname.includes(candidate),
      );
      if (!marker) return '';
      return decodeURIComponent(url.pathname.split(marker)[1] || '');
    } catch {
      return '';
    }
  }

  async createSignedStorageUrl(
    bucket: string,
    storedValue: string | null | undefined,
    expiresInSeconds = 300,
  ): Promise<string | null> {
    if (!storedValue) return null;
    const path = this.storagePath(storedValue, bucket);
    if (!path) return null;
    const { data, error } = await this.getAdminClient()
      .storage.from(bucket)
      .createSignedUrl(path, expiresInSeconds);
    if (error) {
      this.logger.warn(
        `Could not sign ${bucket} object ${path}: ${error.message}`,
      );
      return null;
    }
    return data.signedUrl;
  }

  async createSignedStorageUrls(
    bucket: string,
    storedValues: Array<string | null | undefined>,
    expiresInSeconds = 300,
  ): Promise<Map<string, string | null>> {
    const paths = [
      ...new Set(
        storedValues
          .map((value) => (value ? this.storagePath(value, bucket) : ''))
          .filter(Boolean),
      ),
    ];
    const signed = new Map<string, string | null>();
    if (!paths.length) return signed;
    const storage = this.getAdminClient().storage.from(bucket);
    // Bound each request while deduplicating shared objects in the queue.
    for (let start = 0; start < paths.length; start += 100) {
      const batch = paths.slice(start, start + 100);
      const { data, error } = await storage.createSignedUrls(
        batch,
        expiresInSeconds,
      );
      if (error)
        this.logger.warn(`Could not sign ${bucket} objects: ${error.message}`);
      for (const item of data || []) {
        if (item.path)
          signed.set(item.path, item.error ? null : item.signedUrl || null);
      }
    }
    return new Map(
      storedValues
        .filter((value): value is string => Boolean(value))
        .map((value) => [
          value,
          signed.get(this.storagePath(value, bucket)) || null,
        ]),
    );
  }
}
