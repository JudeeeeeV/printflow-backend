import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from '@supabase/supabase-js';
import { Observable, Subject, filter, interval, map, merge } from 'rxjs';
import { SupabaseService } from '../supabase/supabase.service';

export type DataResource =
  | 'assets'
  | 'devices'
  | 'notifications'
  | 'orders'
  | 'print-jobs'
  | 'receipts'
  | 'shops'
  | 'users';

type Audience = {
  allUsers?: boolean;
  userIds: string[];
  shopIds: string[];
  admins?: boolean;
};

type DataChange = Audience & {
  resources: DataResource[];
  changedAt: string;
};

type ChangeRecord = Record<string, unknown>;

const TABLE_RESOURCES: Record<string, DataResource[]> = {
  assets: ['assets', 'orders'],
  daemon_devices: ['devices'],
  notifications: ['notifications'],
  orders: ['orders'],
  payment_receipts: ['receipts', 'orders'],
  print_jobs: ['print-jobs', 'orders'],
  shops: ['shops'],
  users: ['users'],
};

@Injectable()
export class DataEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataEventsService.name);
  private readonly changes = new Subject<DataChange>();
  private channel?: RealtimeChannel;

  constructor(private readonly supabaseService: SupabaseService) {}

  onModuleInit(): void {
    const client = this.supabaseService.getClient();
    let channel = client.channel('printflow-data-events');
    for (const table of Object.keys(TABLE_RESOURCES)) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => this.publish(table, payload),
      );
    }
    this.channel = channel.subscribe((status, error) => {
      const statusValue = String(status);
      if (statusValue === 'SUBSCRIBED') {
        this.logger.log('Database change stream connected');
      } else if (
        statusValue === 'CHANNEL_ERROR' ||
        statusValue === 'TIMED_OUT'
      ) {
        this.logger.warn(
          `Database change stream ${statusValue.toLowerCase()}: ${error?.message || 'unknown error'}`,
        );
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.changes.complete();
    if (this.channel) {
      await this.supabaseService.getClient().removeChannel(this.channel);
    }
  }

  forUser(userId: string, role: string): Observable<MessageEvent> {
    const isShop = role === 'CLERK' || role === 'MANAGER';
    const updates = this.changes.pipe(
      filter((change) =>
        Boolean(
          change.allUsers ||
          change.userIds.includes(userId) ||
          (isShop && change.shopIds.includes(userId)),
        ),
      ),
      map((change) => ({ data: this.publicChange(change) }) as MessageEvent),
    );
    return merge(updates, this.heartbeat());
  }

  forAdmin(): Observable<MessageEvent> {
    const updates = this.changes.pipe(
      filter((change) => Boolean(change.admins)),
      map((change) => ({ data: this.publicChange(change) }) as MessageEvent),
    );
    return merge(updates, this.heartbeat());
  }

  private heartbeat(): Observable<MessageEvent> {
    return interval(25_000).pipe(
      map(
        () =>
          ({
            data: { resources: [], changedAt: new Date().toISOString() },
          }) as MessageEvent,
      ),
    );
  }

  private publicChange(change: DataChange) {
    return { resources: change.resources, changedAt: change.changedAt };
  }

  private publish(
    table: string,
    payload: RealtimePostgresChangesPayload<ChangeRecord>,
  ): void {
    const record = this.record(payload);
    const audience = this.audience(table, record);
    this.changes.next({
      ...audience,
      resources: TABLE_RESOURCES[table] || [],
      changedAt: new Date().toISOString(),
    });
  }

  private record(
    payload: RealtimePostgresChangesPayload<ChangeRecord>,
  ): ChangeRecord {
    const next =
      'new' in payload && payload.new && Object.keys(payload.new).length
        ? payload.new
        : null;
    const previous = 'old' in payload && payload.old ? payload.old : null;
    return next || previous || {};
  }

  private audience(table: string, record: ChangeRecord): Audience {
    const stringValue = (key: string) =>
      typeof record[key] === 'string' ? record[key] : undefined;
    const id = stringValue('id');
    const userId =
      stringValue('student_id') ||
      stringValue('user_id') ||
      stringValue('recipient_id') ||
      (table === 'users' ? id : undefined);
    const shopId =
      stringValue('shop_id') || (table === 'shops' ? id : undefined);

    return {
      // Shop changes affect the public directory. Receipt/asset changes are
      // signals only and are re-authorized when a client refetches its orders.
      allUsers: ['shops', 'payment_receipts', 'assets'].includes(table),
      userIds: userId ? [userId] : [],
      shopIds: shopId ? [shopId] : [],
      admins: [
        'shops',
        'orders',
        'payment_receipts',
        'daemon_devices',
      ].includes(table),
    };
  }
}
