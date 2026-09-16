import { Injectable } from '@nestjs/common';

interface DeviceConnection {
  socketId: string;
  disconnect: () => void;
  emit: (event: string, payload?: unknown) => void;
}

@Injectable()
export class DeviceConnectionRegistry {
  private readonly connections = new Map<string, DeviceConnection>();

  register(deviceId: string, connection: DeviceConnection) {
    const previous = this.connections.get(deviceId);
    if (previous && previous.socketId !== connection.socketId) {
      previous.disconnect();
    }
    this.connections.set(deviceId, connection);
  }

  unregister(deviceId: string, socketId: string) {
    if (this.connections.get(deviceId)?.socketId === socketId) {
      this.connections.delete(deviceId);
    }
  }

  isConnected(deviceId: string) {
    return this.connections.has(deviceId);
  }

  disconnect(deviceId: string) {
    const connection = this.connections.get(deviceId);
    if (!connection) return false;
    this.connections.delete(deviceId);
    connection.disconnect();
    return true;
  }

  emit(deviceId: string, event: string, payload?: unknown) {
    const connection = this.connections.get(deviceId);
    if (!connection) return false;
    connection.emit(event, payload);
    return true;
  }
}
