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
    for (const bucket of [
      'assets',
      'receipts',
      'permits',
      'gcash_qrs',
      'agent-releases',
    ]) {
      await this.ensurePrivateBucket(bucket);
    }
  }

  async ensurePrivateBucket(bucket: string): Promise<void> {
    const client = this.getAdminClient();
    const { data: buckets, error: listError } =
      await client.storage.listBuckets();
    if (listError) {
      throw new InternalServerErrorException(
        `Failed to inspect storage bucket ${bucket}`,
      );
    }

    const existing = buckets?.find((candidate) => candidate.name === bucket);
    if (!existing) {
      const { error } = await client.storage.createBucket(bucket, {
        public: false,
      });
      if (error) {
        throw new InternalServerErrorException(
          `Failed to create storage bucket ${bucket}`,
        );
      }
      return;
    }

    if (existing.public) {
      const { error } = await client.storage.updateBucket(bucket, {
        public: false,
      });
      if (error) {
        throw new InternalServerErrorException(
          `Failed to secure storage bucket ${bucket}`,
        );
      }
    }
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
    const paths = [...new Set(storedValues.map(value =>
      value ? this.storagePath(value, bucket) : '',
    ).filter(Boolean))];
    const signed = new Map<string, string | null>();
    if (!paths.length) return signed;
    const storage = this.getAdminClient().storage.from(bucket);
    // Bound each request while deduplicating shared objects in the queue.
    for (let start = 0; start < paths.length; start += 100) {
      const batch = paths.slice(start, start + 100);
      const { data, error } = await storage.createSignedUrls(batch, expiresInSeconds);
      if (error) this.logger.warn(`Could not sign ${bucket} objects: ${error.message}`);
      for (const item of data || []) {
        if (item.path) signed.set(item.path, item.error ? null : item.signedUrl || null);
      }
    }
    return new Map(storedValues.filter((value): value is string => Boolean(value))
      .map(value => [value, signed.get(this.storagePath(value, bucket)) || null]));
  }
}
