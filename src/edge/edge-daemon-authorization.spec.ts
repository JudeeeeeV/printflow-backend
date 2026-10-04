import { EdgeDaemonGateway } from './edge-daemon.gateway';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { DeviceConnectionRegistry } from '../daemon-devices/device-connection.registry';

describe('socket authorization lifetime', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function fixture() {
    const validateAgentToken = jest
      .fn()
      .mockResolvedValue({ deviceId: 'device', shopId: 'shop' });
    const gateway = new EdgeDaemonGateway(
      {} as SupabaseService,
      {} as PrintJobsRepository,
      { validateAgentToken } as unknown as DaemonDevicesService,
      new DeviceConnectionRegistry(),
    );
    const socket = {
      id: 'socket',
      connected: true,
      data: {
        connectionRole: 'daemon',
        deviceId: 'device',
        shopId: 'shop',
        expiresAt: Date.now() + 60_000,
      },
      disconnect: jest.fn(),
      emit: jest.fn(),
    };
    socket.disconnect.mockImplementation(() => {
      socket.connected = false;
    });
    const internals = gateway as unknown as {
      scheduleAuthorization: (
        socket: unknown,
        expiresAt: number,
        token?: string,
      ) => void;
      isAuthorized: (socket: unknown) => boolean;
    };
    return { gateway, socket, validateAgentToken, internals };
  }

  it('disconnects on expiry without waiting for traffic', async () => {
    const { gateway, socket, internals } = fixture();
    internals.scheduleAuthorization(socket, socket.data.expiresAt);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    gateway.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('denies expired traffic even if the disconnect timer has not run', () => {
    const { socket, internals } = fixture();
    jest.setSystemTime(Date.now() + 60_001);
    expect(internals.isAuthorized(socket)).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('revalidates device credentials and disconnects remotely revoked devices', async () => {
    const { gateway, socket, internals, validateAgentToken } = fixture();
    validateAgentToken.mockRejectedValue(new Error('Revoked'));
    internals.scheduleAuthorization(
      socket,
      socket.data.expiresAt,
      'agent-token',
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect(validateAgentToken).toHaveBeenCalledWith('agent-token');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    gateway.handleDisconnect(
      socket as unknown as Parameters<EdgeDaemonGateway['handleDisconnect']>[0],
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('avoids overlapping database checks and clears timers on shutdown', async () => {
    const { gateway, socket, internals, validateAgentToken } = fixture();
    validateAgentToken.mockReturnValue(new Promise(() => {}));
    internals.scheduleAuthorization(
      socket,
      Date.now() + 180_000,
      'agent-token',
    );
    await jest.advanceTimersByTimeAsync(90_000);
    expect(validateAgentToken).toHaveBeenCalledTimes(1);
    gateway.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects a missing or invalid expiration', () => {
    const { gateway, socket, internals } = fixture();
    for (const expiresAt of [NaN, 0, Date.now() - 1]) {
      expect(() =>
        internals.scheduleAuthorization(socket, expiresAt),
      ).toThrow();
    }
    gateway.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
