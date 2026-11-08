/**
 * Security regressions using synthetic database adapters and real local sockets.
 * No .env, live database, real accounts, printers, or external network.
 */
import { OrdersService } from '../src/orders/orders.service';
import { AdminService } from '../src/admin/admin.service';
import { EdgeDaemonGateway } from '../src/edge/edge-daemon.gateway';
import { DeviceConnectionRegistry } from '../src/daemon-devices/device-connection.registry';
import { DaemonDevicesService } from '../src/daemon-devices/daemon-devices.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { PrintJobsRepository } from '../src/edge/repositories/print-jobs.repository';
import { PrintAssetService } from '../src/edge/print-asset.service';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  Controller,
  Get,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { configuredTrustProxy } from '../src/common/trust-proxy';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as speakeasy from 'speakeasy';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';

// Small query model that actually evaluates ownership/state predicates and
// applies updates at execution time, allowing deterministic race reproduction.
function database(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      let predicates: Array<(row: any) => boolean> = [];
      let patch: any;
      let inserted: any;
      let columns = '*';
      const execute = (single = false) => {
        if (inserted) tables[table].push({ ...inserted });
        const rows = tables[table].filter((row) =>
          predicates.every((p) => p(row)),
        );
        if (patch)
          rows.forEach((row) => {
            Object.assign(row, patch);
            if (table === 'orders')
              row.draft_version = (row.draft_version || 0) + 1;
          });
        const data = rows.map((row) =>
          columns === '*' || columns.includes('(')
            ? structuredClone(row)
            : Object.fromEntries(
                columns
                  .split(',')
                  .map((key) => [key.trim(), structuredClone(row[key.trim()])]),
              ),
        );
        return { data: single ? (data[0] ?? null) : data, error: null };
      };
      const q: any = {
        select: (value = '*') => {
          columns = value;
          return q;
        },
        eq: (key: string, value: any) => {
          predicates.push((row) => row[key] === value);
          return q;
        },
        neq: (key: string, value: any) => {
          predicates.push((row) => row[key] !== value);
          return q;
        },
        in: (key: string, values: any[]) => {
          predicates.push((row) => values.includes(row[key]));
          return q;
        },
        update: (value: any) => {
          patch = value;
          return q;
        },
        insert: (value: any) => {
          inserted = value;
          return q;
        },
        order: () => q,
        single: async () => execute(true),
        maybeSingle: async () => execute(true),
        then: (resolve: any, reject: any) =>
          Promise.resolve(execute()).then(resolve, reject),
      };
      return q;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Application security regressions', () => {
  it('F01: shop cannot receive or sign assets from an unsubmitted student draft', async () => {
    const db = database({
      shops: [{ id: 'shop', verification_status: 'VERIFIED' }],
      orders: [
        {
          id: 'draft',
          client_id: 'student',
          shop_id: 'shop',
          state: 'DRAFT',
          assets: [{ file_url: 'student/draft/private.pdf' }],
        },
        { id: 'other', shop_id: 'other-shop', state: 'DRAFT', assets: [] },
      ],
    });
    const sign = jest.fn(
      async () => 'https://storage.example.test/signed-private-draft',
    );
    const service = new OrdersService(
      { getAdminClient: () => db, createSignedStorageUrl: sign } as any,
      {} as any,
    );
    const result = await service.getShopOrders('shop');
    expect(result).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
  });

  it('F02: an edit rejects a stale submission, and retry prices the current shop/options', async () => {
    const row = {
      id: 'draft',
      client_id: 'student',
      shop_id: 'cheap-shop',
      state: 'DRAFT',
      draft_version: 0,
      paper_size: 'A4',
      print_color_mode: 'BLACK_AND_WHITE',
      orientation: 'PORTRAIT',
      copies: 1,
      order_name: 'Security regression fixture',
      total: 2,
    };
    const db = database({
      orders: [row],
      shops: [
        {
          id: 'cheap-shop',
          availability_override: true,
          verification_status: 'VERIFIED',
          pricing_matrix: {
            paper_sizes: { A4: 2 },
            color_mode_multipliers: { BLACK_AND_WHITE: 0 },
          },
        },
        {
          id: 'expensive-shop',
          availability_override: true,
          verification_status: 'VERIFIED',
          pricing_matrix: {
            paper_sizes: { A4: 10 },
            color_mode_multipliers: { COLOR: 20 },
          },
        },
      ],
    });
    const service = new OrdersService(
      { getAdminClient: () => db } as any,
      {} as any,
    );
    const submitHasReadOldOptions = deferred();
    const resumeSubmission = deferred();
    let calls = 0;
    jest
      .spyOn(service as any, 'getAssetPageCount')
      .mockImplementation(async () => {
        if (++calls === 1) {
          submitHasReadOldOptions.resolve();
          await resumeSubmission.promise;
        }
        return 1;
      });
    const submission = service.submitDraft('student', 'draft');
    const rejected =
      expect(submission).rejects.toBeInstanceOf(ConflictException);
    await submitHasReadOldOptions.promise;
    try {
      await service.updateDraft('student', 'draft', {
        shopId: 'expensive-shop',
        paperSize: 'A4',
        printColorMode: 'COLOR',
        orderName: 'Security regression fixture',
        orientation: 'PORTRAIT',
        copies: 1,
      });
      expect(row.total).toBe(30);
    } finally {
      resumeSubmission.resolve();
    }
    await rejected;
    expect(row).toMatchObject({
      state: 'DRAFT',
      shop_id: 'expensive-shop',
      print_color_mode: 'COLOR',
      total: 30,
    });
    await service.submitDraft('student', 'draft');
    expect(row).toMatchObject({
      state: 'OPEN_INQUIRY',
      shop_id: 'expensive-shop',
      print_color_mode: 'COLOR',
      total: 30,
    });
  });

  it('F03: sequential and concurrent replay of a real TOTP creates only one admin session', async () => {
    const secret = speakeasy.generateSecret().base32;
    const tables = {
      admins: [
        {
          id: 'admin',
          email: 'admin@example.test',
          is_2fa_enabled: true,
          two_factor_secret_encrypted: 'synthetic-ciphertext',
        },
      ],
      admin_sessions: [] as any[],
    };
    let lastStep = -1;
    const consumed = new Set<string>();
    const rpc = jest.fn(async (name: string, args: any) => {
      if (name === 'reserve_admin_2fa_attempt')
        return { data: !consumed.has(args.p_challenge_hash), error: null };
      if (consumed.has(args.p_challenge_hash) || args.p_totp_step <= lastStep)
        return { data: false, error: null };
      lastStep = args.p_totp_step;
      consumed.add(args.p_challenge_hash);
      tables.admin_sessions.push({ token_id_hash: args.p_session_hash });
      return { data: true, error: null };
    });
    const jwt = new JwtService({
      secret: 'local-test-key-not-a-real-secret-123456789',
      signOptions: { expiresIn: '15m' },
    });
    const service = new AdminService(
      { getAdminClient: () => ({ ...database(tables), rpc }) } as any,
      jwt,
      {} as any,
      { decrypt: () => secret } as any,
    );
    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const result = await Promise.allSettled([
      service.verify2FA('admin', code, 'challenge-a'),
      service.verify2FA('admin', code, 'challenge-b'),
    ]);
    expect(result.filter((value) => value.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(result.filter((value) => value.status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      service.verify2FA('admin', code, 'challenge-a'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tables.admin_sessions).toHaveLength(1);
  });

  it('F04: a real socket disconnects at JWT expiration and cannot report printers afterwards', async () => {
    const jwt = new JwtService({
      secret: 'local-agent-key-not-a-real-secret-123456789',
    });
    const devices = {
      validateAgentToken: jest.fn(async (value: string) => {
        const payload = await jwt.verifyAsync(value, {
          issuer: 'printflow-api',
          audience: 'printflow-daemon',
        });
        return {
          deviceId: 'device',
          shopId: 'shop',
          deviceName: 'Synthetic device',
          expiresAt: payload.exp * 1000,
        };
      }),
      touch: jest.fn(async () => undefined),
      updatePrinters: jest.fn(async () => undefined),
    };
    const module = await Test.createTestingModule({
      providers: [
        EdgeDaemonGateway,
        DeviceConnectionRegistry,
        { provide: DaemonDevicesService, useValue: devices },
        { provide: SupabaseService, useValue: {} },
        { provide: PrintJobsRepository, useValue: {} },
        { provide: PrintAssetService, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useLogger(false);
    let socket: Socket | undefined;
    const event = (name: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out: ${name}`)),
          2500,
        );
        socket!.once(name, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    try {
      await app.listen(0, '127.0.0.1');
      const token = jwt.sign(
        { sub: 'device', deviceId: 'device', shopId: 'shop', role: 'daemon' },
        { expiresIn: 2, issuer: 'printflow-api', audience: 'printflow-daemon' },
      );
      socket = io(`${await app.getUrl()}/daemon`, {
        autoConnect: false,
        reconnection: false,
        transports: ['websocket'],
        query: { role: 'daemon' },
        auth: { token },
      });
      const online = event('daemon_status');
      socket.connect();
      await online;
      const disconnected = event('disconnect');
      await disconnected;
      expect(() => jwt.verify(token)).toThrow('jwt expired');
      socket.emit('daemon_printers_update', {
        printers: ['Expired session printer'],
      });
      expect(socket.connected).toBe(false);
      expect(devices.validateAgentToken).toHaveBeenCalledTimes(1);
      expect(devices.updatePrinters).not.toHaveBeenCalled();
      expect(
        app.get(EdgeDaemonGateway).emitPrintCommands('shop', 'device', []),
      ).toBe(false);
    } finally {
      socket?.disconnect();
      await app.close();
    }
  });
});

@Controller('probe')
class ProbeController {
  @Get()
  probe() {
    return { ok: true };
  }
}

it('C01: a direct deployment ignores spoofed forwarding headers and cannot bypass throttling', async () => {
  const module = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 1 }])],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = module.createNestApplication();
  app.useLogger(false);
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', configuredTrustProxy('false'));
  await app.init();
  try {
    await request(app.getHttpServer())
      .get('/probe')
      .set('X-Forwarded-For', '192.0.2.1')
      .expect(200);
    await request(app.getHttpServer())
      .get('/probe')
      .set('X-Forwarded-For', '192.0.2.1')
      .expect(429);
    await request(app.getHttpServer())
      .get('/probe')
      .set('X-Forwarded-For', '192.0.2.2')
      .expect(429);
  } finally {
    await app.close();
  }
});
