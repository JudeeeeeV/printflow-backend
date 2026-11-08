import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { DeviceConnectionRegistry } from '../daemon-devices/device-connection.registry';
import { PrintAssetService } from './print-asset.service';

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const attemptRow = (overrides: Record<string, unknown> = {}) => ({
  attempt_id: ATTEMPT,
  order_id: '22222222-2222-4222-8222-222222222222',
  shop_id: 'shop-1',
  status: 'QUEUED',
  attempt_number: 1,
  attempt_kind: 'INITIAL',
  execution_mode: 'AGENT',
  device_id: 'device-1',
  printer_name: 'Desk',
  print_settings: { colorMode: 'COLOR', paperSize: 'A4', copies: 2 },
  printable_path: 'print-ready/file.pdf',
  printable_sha256: 'a'.repeat(64),
  printable_size: 10,
  revision_ref: 'source.pdf',
  resolved_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 1500);
    socket.once(name, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('EdgeDaemonGateway connections', () => {
  let app: INestApplication;
  let gateway: EdgeDaemonGateway;
  let registry: DeviceConnectionRegistry;
  let url: string;
  let clients: Socket[];
  const identity = {
    shopId: 'shop-1',
    deviceId: 'device-1',
    deviceName: 'Desk',
    expiresAt: Date.now() + 60_000,
  };
  const devices = {
    validateAgentToken: jest.fn(),
    touch: jest.fn().mockResolvedValue(undefined),
    updatePrinters: jest.fn().mockResolvedValue(undefined),
  };
  const getUser = jest.fn();
  const jobs = {
    recordAgentEvent: jest.fn(),
    authorizeAttempt: jest.fn(),
    findAttempts: jest.fn(),
    findRedeliverable: jest.fn(),
    touchWaitingAttempts: jest.fn(),
  };
  const assets = { sign: jest.fn().mockResolvedValue('https://signed.test') };
  const originalLegacyAuth = process.env.ALLOW_LEGACY_DAEMON_AUTH;

  beforeEach(async () => {
    process.env.ALLOW_LEGACY_DAEMON_AUTH = 'false';
    jest.clearAllMocks();
    clients = [];
    devices.validateAgentToken.mockReset().mockResolvedValue(identity);
    getUser.mockReset().mockResolvedValue({ data: { user: { id: 'shop-1' } } });
    jobs.findRedeliverable.mockReset().mockResolvedValue([]);
    jobs.recordAgentEvent.mockReset();
    jobs.authorizeAttempt.mockReset();
    jobs.findAttempts.mockReset().mockResolvedValue([]);
    const module = await Test.createTestingModule({
      providers: [
        EdgeDaemonGateway,
        DeviceConnectionRegistry,
        { provide: DaemonDevicesService, useValue: devices },
        { provide: PrintJobsRepository, useValue: jobs },
        { provide: PrintAssetService, useValue: assets },
        {
          provide: SupabaseService,
          useValue: {
            getAdminClient: () => ({
              auth: { getUser },
              from: (table: string) => {
                const query = {
                  select: () => query,
                  eq: () => query,
                  single: () =>
                    Promise.resolve({
                      data:
                        table === 'users'
                          ? { role: 'MANAGER' }
                          : { id: 'shop-1' },
                    }),
                };
                return query;
              },
            }),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    gateway = app.get(EdgeDaemonGateway);
    registry = app.get(DeviceConnectionRegistry);
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/daemon`;
  });

  afterEach(async () => {
    clients.forEach((client) => client.disconnect());
    await app.close();
    if (originalLegacyAuth === undefined)
      delete process.env.ALLOW_LEGACY_DAEMON_AUTH;
    else process.env.ALLOW_LEGACY_DAEMON_AUTH = originalLegacyAuth;
  });

  function client(role = 'daemon', legacy = false) {
    const socket = io(url, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      query: { role, shopId: 'shop-1' },
      auth: {
        token:
          role === 'clerk'
            ? `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`
            : 'test-token',
        ...(role === 'daemon' && !legacy
          ? { protocolVersion: 2, capabilities: ['attempt-reporting-v1'] }
          : {}),
      },
    });
    clients.push(socket);
    return socket;
  }

  async function connectAgent(legacy = false) {
    const agent = client('daemon', legacy);
    const online = event<{ status: string }>(agent, 'daemon_status');
    agent.connect();
    expect(await online).toEqual(
      legacy
        ? { status: 'CONNECTED', agentUpdateRequired: true }
        : { status: 'CONNECTED' },
    );
    return agent;
  }

  it('accepts an immediate printer report while agent authentication is pending', async () => {
    const auth = deferred<typeof identity>();
    devices.validateAgentToken.mockReturnValue(auth.promise);
    const agent = client();
    const connected = event(agent, 'connect');
    const printers = event<string[]>(agent, 'printers_list');
    agent.on('connect', () =>
      agent.emit('daemon_printers_update', { printers: ['Desk Printer'] }),
    );
    agent.connect();
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stayedConnected = agent.connected;
    auth.resolve(identity);
    expect(await printers).toEqual(['Desk Printer']);
    expect(stayedConnected).toBe(true);
    expect(devices.updatePrinters).toHaveBeenCalledWith('device-1', [
      'Desk Printer',
    ]);
  });

  it('answers the dashboard status request made immediately after login', async () => {
    await connectAgent();
    const auth = deferred<{ data: { user: { id: string } } }>();
    getUser.mockReturnValue(auth.promise);
    const clerk = client('clerk');
    const connected = event(clerk, 'connect');
    const status = event<{ status: string }>(clerk, 'daemon_status');
    clerk.on('connect', () => clerk.emit('check_daemon_status'));
    clerk.connect();
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 30));
    auth.resolve({ data: { user: { id: 'shop-1' } } });
    expect(await status).toEqual({ status: 'CONNECTED' });
  });

  it('finds the live daemon and delivers attempt commands only to the assigned device', async () => {
    const agent = await connectAgent();
    expect(gateway.hasConnectedDaemon('shop-1')).toBe(true);
    expect(gateway.getConnectedAgent('shop-1')).toEqual({
      deviceId: 'device-1',
      supportsAttempts: true,
    });
    expect(gateway.emitPrintCommands('shop-1', 'other-device', [])).toBe(false);
    const batch = event(agent, 'print_attempts');
    expect(gateway.emitPrintCommands('shop-1', 'device-1', [])).toBe(true);
    expect(await batch).toEqual({ protocolVersion: 2, commands: [] });
  });

  it('acknowledges agent events only after persistence and replays duplicates safely', async () => {
    const agent = await connectAgent();
    const clerk = client('clerk');
    const ready = event(clerk, 'daemon_status');
    clerk.connect();
    await ready;
    jobs.recordAgentEvent.mockResolvedValueOnce({
      ok: true,
      result: 'APPLIED',
      attempt: attemptRow({ status: 'SUBMITTED' }),
    });
    const progress = event<Record<string, unknown>>(clerk, 'job_progress');
    const ack: unknown = await agent.emitWithAck('attempt_event', {
      attemptId: ATTEMPT,
      sequence: 4,
      status: 'SUBMITTED',
    });
    expect(ack).toEqual({ ack: true, result: 'APPLIED' });
    expect(jobs.recordAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT,
        shopId: 'shop-1',
        deviceId: 'device-1',
        sequence: 4,
        status: 'SUBMITTED',
      }),
    );
    expect(await progress).toMatchObject({
      attemptId: ATTEMPT,
      status: 'SUBMITTED',
      printerName: 'Desk',
    });

    jobs.recordAgentEvent.mockResolvedValueOnce({
      ok: true,
      result: 'DUPLICATE',
    });
    expect(
      await agent.emitWithAck('attempt_event', {
        attemptId: ATTEMPT,
        sequence: 4,
        status: 'SUBMITTED',
      }),
    ).toEqual({ ack: true, result: 'DUPLICATE' });

    jobs.recordAgentEvent.mockRejectedValueOnce(new Error('database down'));
    expect(
      await agent.emitWithAck('attempt_event', {
        attemptId: ATTEMPT,
        sequence: 5,
        status: 'OUTCOME_UNKNOWN',
      }),
    ).toEqual({ ack: false, retry: true, code: 'NOT_PERSISTED' });

    jobs.recordAgentEvent.mockResolvedValueOnce({
      ok: false,
      code: 'WRONG_DEVICE',
    });
    expect(
      await agent.emitWithAck('attempt_event', {
        attemptId: ATTEMPT,
        sequence: 6,
        status: 'SUBMITTED',
      }),
    ).toEqual({ ack: false, retry: false, code: 'WRONG_DEVICE' });

    expect(
      await agent.emitWithAck('attempt_event', {
        attemptId: 'not-a-uuid',
        sequence: 1,
        status: 'COMPLETED',
      }),
    ).toEqual({ ack: false, retry: false, code: 'INVALID_EVENT' });
    expect(jobs.recordAgentEvent).toHaveBeenCalledTimes(4);
  });

  it('authorizes attempts with the authenticated device identity', async () => {
    const agent = await connectAgent();
    jobs.authorizeAttempt.mockResolvedValue({ authorized: true });
    expect(
      await agent.emitWithAck('attempt_authorize', { attemptId: ATTEMPT }),
    ).toEqual({ authorized: true });
    expect(jobs.authorizeAttempt).toHaveBeenCalledWith(
      ATTEMPT,
      'shop-1',
      'device-1',
    );
    jobs.authorizeAttempt.mockRejectedValue(new Error('down'));
    expect(
      await agent.emitWithAck('attempt_authorize', { attemptId: ATTEMPT }),
    ).toEqual({ authorized: false, reason: 'UNAVAILABLE' });
  });

  it('redelivers pending attempts for the reconnecting device', async () => {
    jobs.findRedeliverable.mockResolvedValue([attemptRow()]);
    const agent = client();
    const delivered = event<{ commands: Array<Record<string, unknown>> }>(
      agent,
      'print_attempts',
    );
    agent.connect();
    const payload = await delivered;
    expect(jobs.findRedeliverable).toHaveBeenCalledWith('device-1', 'shop-1');
    expect(payload).toMatchObject({ redelivery: true });
    expect(payload.commands[0]).toEqual({
      attemptId: ATTEMPT,
      orderId: '22222222-2222-4222-8222-222222222222',
      revisionId: 'source.pdf',
      deviceId: 'device-1',
      printerName: 'Desk',
      settings: {
        colorMode: 'COLOR',
        paperSize: 'A4',
        orientation: 'PORTRAIT',
        copies: 2,
      },
      file: {
        url: 'https://signed.test',
        sha256: 'a'.repeat(64),
        size: 10,
      },
    });
  });

  it('marks older agents as update-required and ignores their order-only callbacks', async () => {
    const agent = await connectAgent(true);
    expect(gateway.getConnectedAgent('shop-1')).toEqual({
      deviceId: 'device-1',
      supportsAttempts: false,
    });
    expect(gateway.emitPrintCommands('shop-1', 'device-1', [])).toBe(false);
    expect(
      await agent.emitWithAck('job_status_update', {
        orderId: '22222222-2222-4222-8222-222222222222',
        status: 'COMPLETED',
      }),
    ).toEqual({ ack: false, code: 'AGENT_UPDATE_REQUIRED' });
    expect(
      await agent.emitWithAck('attempt_event', {
        attemptId: ATTEMPT,
        sequence: 1,
        status: 'SUBMITTED',
      }),
    ).toEqual({ ack: false, retry: false, code: 'UNAUTHORIZED' });
    expect(jobs.recordAgentEvent).not.toHaveBeenCalled();
    expect(jobs.findRedeliverable).not.toHaveBeenCalled();
  });

  it('replaces a previous daemon connection without rejecting the new one', async () => {
    const previous = await connectAgent();
    const disconnected = event(previous, 'disconnect');
    const replacement = await connectAgent();
    await disconnected;
    expect(replacement.connected).toBe(true);
    expect(registry.isConnected('device-1')).toBe(true);
  });

  it('does not register a socket that disconnected during authentication', async () => {
    const auth = deferred<typeof identity>();
    devices.validateAgentToken.mockReturnValue(auth.promise);
    const agent = client();
    const connected = event(agent, 'connect');
    agent.connect();
    await connected;
    agent.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    auth.resolve(identity);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(registry.isConnected('device-1')).toBe(false);
    expect(devices.touch).not.toHaveBeenCalled();
  });

  it('rejects invalid credentials without accepting a queued printer report', async () => {
    devices.validateAgentToken.mockRejectedValue(new Error('Invalid token'));
    const agent = client();
    const disconnected = event(agent, 'disconnect');
    agent.on('connect', () =>
      agent.emit('daemon_printers_update', { printers: ['Untrusted'] }),
    );
    agent.connect();
    await disconnected;
    expect(devices.updatePrinters).not.toHaveBeenCalled();
    expect(registry.isConnected('device-1')).toBe(false);
  });

  it('refreshes printer lists and offline status on the same dashboard connection', async () => {
    const agent = await connectAgent();
    const clerk = client('clerk');
    const initialPrinters = event<string[]>(clerk, 'printers_list');
    clerk.connect();
    expect(await initialPrinters).toEqual([]);

    const detected = event<string[]>(clerk, 'printers_list');
    agent.emit('daemon_printers_update', { printers: ['Desk'] });
    expect(await detected).toEqual(['Desk']);
    expect(registry.getPrinters('device-1')).toEqual(['Desk']);
    expect(gateway.getAvailablePrinters('shop-1')).toEqual(['Desk']);
    expect(gateway.getAvailablePrinters('another-shop')).toEqual([]);
    const snapshot = event<string[]>(clerk, 'printers_list');
    clerk.emit('check_daemon_status');
    expect(await snapshot).toEqual(['Desk']);

    const removed = event<string[]>(clerk, 'printers_list');
    agent.emit('daemon_printers_update', { printers: [] });
    expect(await removed).toEqual([]);
    const offline = event<{ status: string }>(clerk, 'daemon_status');
    agent.disconnect();
    expect(await offline).toEqual({ status: 'OFFLINE' });
    expect(gateway.getAvailablePrinters('shop-1')).toEqual([]);
    const empty = event<string[]>(clerk, 'printers_list');
    clerk.emit('check_daemon_status');
    expect(await empty).toEqual([]);
    expect(clerk.connected).toBe(true);
  });
});
