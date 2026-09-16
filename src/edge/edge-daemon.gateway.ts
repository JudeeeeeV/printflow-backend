import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { DeviceConnectionRegistry } from '../daemon-devices/device-connection.registry';

type ConnectionRole = 'daemon' | 'clerk';
type UserRole = 'CLERK' | 'MANAGER';

const isUserRole = (value: unknown): value is UserRole =>
  value === 'CLERK' || value === 'MANAGER';

interface SocketIdentity {
  shopId?: string;
  userId?: string;
  deviceId?: string;
  connectionRole?: ConnectionRole;
  userRole?: UserRole;
}

type PrintflowSocket = Omit<Socket, 'data'> & { data: SocketIdentity };

const websocketOrigin = (
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) => {
  const allowedOrigins = [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    process.env.ADMIN_URL || 'http://localhost:3001',
  ];
  if (!origin || allowedOrigins.includes(origin)) callback(null, true);
  else callback(new Error('Origin is not allowed'), false);
};

@WebSocketGateway({ cors: { origin: websocketOrigin }, namespace: '/daemon' })
export class EdgeDaemonGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EdgeDaemonGateway.name);
  private readonly connectedDaemons = new Map<string, string>();
  private readonly shopPrinters = new Map<string, string[]>();
  private readonly deviceTouches = new Map<string, number>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly printJobsRepository: PrintJobsRepository,
    private readonly daemonDevices: DaemonDevicesService,
    private readonly deviceConnections: DeviceConnectionRegistry,
  ) {}

  async handleConnection(client: PrintflowSocket) {
    const shopIdValue = client.handshake.query.shopId;
    const shopId = typeof shopIdValue === 'string' ? shopIdValue : undefined;
    const connectionRoleValue = client.handshake.query.role;
    const connectionRole =
      connectionRoleValue === 'daemon' || connectionRoleValue === 'clerk'
        ? connectionRoleValue
        : undefined;
    const handshakeAuth = client.handshake.auth as Record<string, unknown>;
    const tokenValue = handshakeAuth.token;
    const token = typeof tokenValue === 'string' ? tokenValue : undefined;

    if (!token || !connectionRole || (connectionRole === 'clerk' && !shopId)) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
      return;
    }

    if (connectionRole === 'daemon') {
      try {
        const identity = await this.daemonDevices.validateAgentToken(token);
        if (shopId && shopId !== identity.shopId) {
          this.logger.warn(
            `Rejected daemon with mismatched shop: ${client.id}`,
          );
          client.disconnect(true);
          return;
        }

        client.data.shopId = identity.shopId;
        client.data.deviceId = identity.deviceId;
        client.data.connectionRole = 'daemon';
        void client.join(`shop_${identity.shopId}`);

        const previousSocketId = this.connectedDaemons.get(identity.shopId);
        if (previousSocketId && previousSocketId !== client.id) {
          this.server.sockets.sockets.get(previousSocketId)?.disconnect(true);
        }
        this.connectedDaemons.set(identity.shopId, client.id);
        this.deviceConnections.register(identity.deviceId, {
          socketId: client.id,
          disconnect: () => client.disconnect(true),
          emit: (event, payload) => client.emit(event, payload),
        });
        await this.daemonDevices.touch(
          identity.deviceId,
          this.agentVersion(client),
        );
        this.logger.log(
          `Authenticated printer agent connected for shop ${identity.shopId}: ${identity.deviceName}`,
        );
        this.server.to(`shop_${identity.shopId}`).emit('daemon_status', {
          status: 'CONNECTED',
        });
      } catch (error) {
        if (
          shopId &&
          this.legacyDaemonAuthEnabled() &&
          (await this.connectLegacyDaemon(client, token, shopId))
        ) {
          return;
        }
        const message =
          error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(`Rejected printer agent ${client.id}: ${message}`);
        client.disconnect(true);
      }
      return;
    }

    const supabase = this.supabaseService.getAdminClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user || user.id !== shopId) {
      this.logger.warn(`Rejected socket with invalid identity: ${client.id}`);
      client.disconnect(true);
      return;
    }

    const [
      { data: profile, error: profileError },
      { data: shop, error: shopError },
    ] = await Promise.all([
      supabase.from('users').select('role').eq('id', user.id).single(),
      supabase
        .from('shops')
        .select('id')
        .eq('id', user.id)
        .eq('verification_status', 'VERIFIED')
        .single(),
    ]);
    const profileRecord = profile as unknown as { role?: unknown } | null;
    if (
      profileError ||
      shopError ||
      !shop ||
      !profileRecord ||
      !isUserRole(profileRecord.role)
    ) {
      this.logger.warn(`Rejected socket for an unverified shop: ${client.id}`);
      client.disconnect(true);
      return;
    }

    client.data.shopId = shopId;
    client.data.userId = user.id;
    client.data.connectionRole = connectionRole;
    client.data.userRole = profileRecord.role;
    void client.join(`shop_${shopId}`);

    this.logger.log(`Authenticated clerk connected for shop: ${shopId}`);
  }

  handleDisconnect(client: PrintflowSocket) {
    const shopId = client.data.shopId;
    const deviceId = client.data.deviceId;
    if (deviceId) {
      this.deviceConnections.unregister(deviceId, client.id);
      this.deviceTouches.delete(deviceId);
    }
    if (
      shopId &&
      client.data.connectionRole === 'daemon' &&
      this.connectedDaemons.get(shopId) === client.id
    ) {
      this.connectedDaemons.delete(shopId);
      this.shopPrinters.delete(shopId);
      this.server.to(`shop_${shopId}`).emit('daemon_status', {
        status: 'OFFLINE',
      });
    }
  }

  hasConnectedDaemon(shopId: string): boolean {
    const socketId = this.connectedDaemons.get(shopId);
    return Boolean(socketId && this.server.sockets.sockets.has(socketId));
  }

  emitBatchExecute(shopId: string, payload: unknown): boolean {
    const socketId = this.connectedDaemons.get(shopId);
    const daemon = socketId
      ? this.server.sockets.sockets.get(socketId)
      : undefined;
    if (!daemon) return false;
    daemon.emit('batch_execute', payload);
    return true;
  }

  @SubscribeMessage('job_status_update')
  async handleJobStatusUpdate(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: { orderId: string; status: string },
  ) {
    if (client.data.connectionRole !== 'daemon') {
      client.disconnect(true);
      return { ack: false };
    }

    const shopId = client.data.shopId;
    const deviceId = client.data.deviceId;
    if (!shopId) return { ack: false };
    if (!deviceId && !client.data.userId) return { ack: false };
    const allowedStatuses = [
      'DOWNLOADING',
      'SENT_TO_SPOOLER',
      'COMPLETED',
      'FAILED',
    ];
    if (
      !data ||
      typeof data.orderId !== 'string' ||
      !allowedStatuses.includes(data.status)
    ) {
      return { ack: false };
    }

    const supabase = this.supabaseService.getAdminClient();
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, state')
      .eq('id', data.orderId)
      .eq('shop_id', shopId)
      .single();
    if (error || !order || order.state !== 'IN_PRODUCTION') {
      return { ack: false };
    }

    if (data.status === 'COMPLETED') {
      const { data: updatedOrder } = await supabase
        .from('orders')
        .update({ state: 'PRINTED' })
        .eq('id', data.orderId)
        .eq('shop_id', shopId)
        .eq('state', 'IN_PRODUCTION')
        .select('id')
        .maybeSingle();
      if (!updatedOrder) return { ack: false };
    }

    await this.printJobsRepository.updateJobStatus(
      data.orderId,
      shopId,
      data.status,
    );

    this.server.to(`shop_${shopId}`).emit('job_progress', {
      orderId: data.orderId,
      status: data.status,
    });
    return { ack: true };
  }

  @SubscribeMessage('check_daemon_status')
  handleCheckStatus(@ConnectedSocket() client: PrintflowSocket) {
    if (client.data.connectionRole !== 'clerk') return;
    const shopId = client.data.shopId;
    if (!shopId) return;
    const isOnline = this.connectedDaemons.has(shopId);
    client.emit('daemon_status', {
      status: isOnline ? 'CONNECTED' : 'OFFLINE',
    });
    if (isOnline && this.shopPrinters.has(shopId)) {
      client.emit('printers_list', this.shopPrinters.get(shopId));
    }
  }

  @SubscribeMessage('daemon_printers_update')
  handleDaemonPrintersUpdate(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: { printers: string[] },
  ) {
    if (client.data.connectionRole !== 'daemon') {
      client.disconnect(true);
      return;
    }
    const shopId = client.data.shopId;
    const deviceId = client.data.deviceId;
    if (!shopId || (!deviceId && !client.data.userId)) return;
    if (
      !data ||
      !Array.isArray(data.printers) ||
      data.printers.length > 100 ||
      data.printers.some(
        (printer) => typeof printer !== 'string' || printer.length > 200,
      )
    ) {
      return;
    }
    this.shopPrinters.set(shopId, data.printers);
    if (deviceId) {
      void this.daemonDevices
        .updatePrinters(deviceId, data.printers)
        .catch((error) => {
          this.logger.warn(
            `Failed to persist printer list for device ${deviceId}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
    }
    this.server.to(`shop_${shopId}`).emit('printers_list', data.printers);
  }

  @SubscribeMessage('daemon_heartbeat')
  handleDaemonHeartbeat(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: { agentVersion?: string },
  ) {
    if (client.data.connectionRole !== 'daemon' || !client.data.deviceId) {
      client.disconnect(true);
      return { ack: false };
    }
    const now = Date.now();
    const lastTouch = this.deviceTouches.get(client.data.deviceId) || 0;
    if (now - lastTouch >= 60_000) {
      this.deviceTouches.set(client.data.deviceId, now);
      const version =
        typeof data?.agentVersion === 'string'
          ? data.agentVersion.slice(0, 40)
          : this.agentVersion(client);
      void this.daemonDevices
        .touch(client.data.deviceId, version)
        .catch((error) => {
          this.logger.warn(
            `Failed to update heartbeat for device ${client.data.deviceId}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
    }
    return { ack: true };
  }

  private agentVersion(client: PrintflowSocket) {
    const auth = client.handshake.auth as Record<string, unknown>;
    const value = auth.agentVersion;
    return typeof value === 'string' ? value.slice(0, 40) : undefined;
  }

  private legacyDaemonAuthEnabled() {
    if (process.env.NODE_ENV === 'production') {
      return process.env.ALLOW_LEGACY_DAEMON_AUTH === 'true';
    }
    return process.env.ALLOW_LEGACY_DAEMON_AUTH !== 'false';
  }

  private async connectLegacyDaemon(
    client: PrintflowSocket,
    token: string,
    shopId: string,
  ) {
    const supabase = this.supabaseService.getAdminClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);
    if (authError || !user || user.id !== shopId) return false;

    const [
      { data: profile, error: profileError },
      { data: shop, error: shopError },
    ] = await Promise.all([
      supabase.from('users').select('role').eq('id', user.id).single(),
      supabase
        .from('shops')
        .select('id')
        .eq('id', user.id)
        .eq('verification_status', 'VERIFIED')
        .single(),
    ]);
    const profileRecord = profile as unknown as { role?: unknown } | null;
    if (
      profileError ||
      shopError ||
      !shop ||
      !profileRecord ||
      !isUserRole(profileRecord.role)
    ) {
      return false;
    }

    client.data.shopId = shopId;
    client.data.userId = user.id;
    client.data.connectionRole = 'daemon';
    client.data.userRole = profileRecord.role;
    void client.join(`shop_${shopId}`);
    const previousSocketId = this.connectedDaemons.get(shopId);
    if (previousSocketId && previousSocketId !== client.id) {
      this.server.sockets.sockets.get(previousSocketId)?.disconnect(true);
    }
    this.connectedDaemons.set(shopId, client.id);
    this.logger.warn(`Legacy development daemon connected for shop: ${shopId}`);
    this.server.to(`shop_${shopId}`).emit('daemon_status', {
      status: 'CONNECTED',
    });
    return true;
  }
}
