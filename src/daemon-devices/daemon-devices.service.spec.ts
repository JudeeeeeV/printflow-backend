import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DaemonDevicesService } from './daemon-devices.service';
import { DeviceConnectionRegistry } from './device-connection.registry';

const device = {
  id: '11111111-1111-4111-8111-111111111111',
  shop_id: '22222222-2222-4222-8222-222222222222',
  name: 'Front Desk PC',
  secret_hash: createHash('sha256')
    .update('valid-device-secret-value')
    .digest('hex'),
  agent_version: '0.1.0',
  printers: ['Test Printer'],
  last_seen_at: null,
  revoked_at: null,
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:00:00.000Z',
};

function queryReturning(result: unknown) {
  const chain: any = {};
  for (const method of ['select', 'eq', 'is', 'update', 'delete']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.single = jest.fn(async () => result);
  chain.maybeSingle = jest.fn(async () => result);
  return chain;
}

describe('DaemonDevicesService', () => {
  it('accepts a valid short-lived agent identity for an active verified shop', async () => {
    const deviceQuery = queryReturning({ data: device, error: null });
    const shopQuery = queryReturning({
      data: { id: device.shop_id },
      error: null,
    });
    const getAdminClient = jest
      .fn()
      .mockReturnValueOnce({ from: () => deviceQuery })
      .mockReturnValueOnce({ from: () => shopQuery });
    const jwtService = {
      verifyAsync: jest.fn(async () => ({
        sub: device.id,
        deviceId: device.id,
        shopId: device.shop_id,
        role: 'daemon',
      })),
    };
    const service = new DaemonDevicesService(
      { getAdminClient } as any,
      jwtService as any,
      new DeviceConnectionRegistry(),
    );

    await expect(service.validateAgentToken('signed-token')).resolves.toEqual({
      deviceId: device.id,
      shopId: device.shop_id,
      deviceName: device.name,
    });
    expect(jwtService.verifyAsync).toHaveBeenCalledWith(
      'signed-token',
      expect.objectContaining({ audience: 'printflow-daemon' }),
    );
  });

  it('rejects a revoked device even when its JWT is correctly signed', async () => {
    const deviceQuery = queryReturning({
      data: { ...device, revoked_at: '2026-09-16T01:00:00.000Z' },
      error: null,
    });
    const service = new DaemonDevicesService(
      { getAdminClient: () => ({ from: () => deviceQuery }) } as any,
      {
        verifyAsync: async () => ({
          sub: device.id,
          deviceId: device.id,
          shopId: device.shop_id,
          role: 'daemon',
        }),
      } as any,
      new DeviceConnectionRegistry(),
    );

    await expect(
      service.validateAgentToken('signed-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an incorrect device secret before issuing a token', async () => {
    const deviceQuery = queryReturning({ data: device, error: null });
    const jwtService = { signAsync: jest.fn() };
    const service = new DaemonDevicesService(
      { getAdminClient: () => ({ from: () => deviceQuery }) } as any,
      jwtService as any,
      new DeviceConnectionRegistry(),
    );

    await expect(
      service.exchangeToken({
        deviceId: device.id,
        deviceSecret: 'this-secret-is-definitely-incorrect',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('deletes a device and disconnects it when a shop revokes access', async () => {
    const deleteQuery = queryReturning({
      data: { id: device.id },
      error: null,
    });
    const adminClient = { from: jest.fn(() => deleteQuery) };
    const connections = new DeviceConnectionRegistry();
    const disconnect = jest.spyOn(connections, 'disconnect');
    const service = new DaemonDevicesService(
      { getAdminClient: () => adminClient } as any,
      {} as any,
      connections,
    );

    await expect(
      service.revokeForShop(device.id, device.shop_id, 'MANAGER'),
    ).resolves.toEqual({ message: 'Printer agent removed successfully.' });
    expect(deleteQuery.delete).toHaveBeenCalled();
    expect(deleteQuery.eq).toHaveBeenCalledWith('id', device.id);
    expect(deleteQuery.eq).toHaveBeenCalledWith('shop_id', device.shop_id);
    expect(disconnect).toHaveBeenCalledWith(device.id);
  });
});
