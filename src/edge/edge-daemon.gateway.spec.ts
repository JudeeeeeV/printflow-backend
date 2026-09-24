import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { DeviceConnectionRegistry } from '../daemon-devices/device-connection.registry';

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
  };
  const devices = {
    validateAgentToken: jest.fn(),
    touch: jest.fn().mockResolvedValue(undefined),
    updatePrinters: jest.fn().mockResolvedValue(undefined),
  };
  const getUser = jest.fn();
  const originalLegacyAuth = process.env.ALLOW_LEGACY_DAEMON_AUTH;

  beforeEach(async () => {
    process.env.ALLOW_LEGACY_DAEMON_AUTH = 'false';
    jest.clearAllMocks();
    clients = [];
    devices.validateAgentToken.mockReset().mockResolvedValue(identity);
    getUser.mockReset().mockResolvedValue({ data: { user: { id: 'shop-1' } } });
    const module = await Test.createTestingModule({
      providers: [
        EdgeDaemonGateway,
        DeviceConnectionRegistry,
        { provide: DaemonDevicesService, useValue: devices },
        { provide: PrintJobsRepository, useValue: {} },
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

  function client(role = 'daemon') {
    const socket = io(url, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      query: { role, shopId: 'shop-1' },
      auth: { token: 'test-token' },
    });
    clients.push(socket);
    return socket;
  }

  async function connectAgent() {
    const agent = client();
    const online = event<{ status: string }>(agent, 'daemon_status');
    agent.connect();
    expect(await online).toEqual({ status: 'CONNECTED' });
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

  it('finds the live daemon in its namespace and delivers print batches', async () => {
    const agent = await connectAgent();
    expect(gateway.hasConnectedDaemon('shop-1')).toBe(true);
    const batch = event(agent, 'batch_execute');
    expect(gateway.emitBatchExecute('shop-1', { jobs: [] })).toBe(true);
    expect(await batch).toEqual({ jobs: [] });
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
