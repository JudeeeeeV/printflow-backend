import { DeviceConnectionRegistry } from './device-connection.registry';

describe('DeviceConnectionRegistry printer reports', () => {
  it('uses only the current connection report and preserves a confirmed empty list', () => {
    const registry = new DeviceConnectionRegistry();
    registry.register('device', {
      socketId: 'old',
      disconnect: jest.fn(),
      emit: jest.fn(),
    });
    registry.setPrinters('device', 'old', ['Desk']);
    expect(registry.getPrinters('device')).toEqual(['Desk']);
    registry.register('device', {
      socketId: 'new',
      disconnect: jest.fn(),
      emit: jest.fn(),
    });
    expect(registry.getPrinters('device')).toBeUndefined();
    registry.setPrinters('device', 'old', ['Stale']);
    expect(registry.getPrinters('device')).toBeUndefined();
    registry.setPrinters('device', 'new', []);
    expect(registry.getPrinters('device')).toEqual([]);
    registry.unregister('device', 'old');
    expect(registry.getPrinters('device')).toEqual([]);
    registry.unregister('device', 'new');
    expect(registry.getPrinters('device')).toBeUndefined();
  });
});
