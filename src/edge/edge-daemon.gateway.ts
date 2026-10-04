import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Namespace, Socket } from 'socket.io';
import { SupabaseService } from '../supabase/supabase.service';
import { PrintJobsRepository } from './repositories/print-jobs.repository';
import { DaemonDevicesService } from '../daemon-devices/daemon-devices.service';
import { DeviceConnectionRegistry } from '../daemon-devices/device-connection.registry';
import { readCookie, USER_ACCESS_COOKIE } from '../auth/auth-cookies';

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
  expiresAt?: number;
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

@WebSocketGateway({
  cors: { origin: websocketOrigin, credentials: true },
  namespace: '/daemon',
})
export class EdgeDaemonGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(EdgeDaemonGateway.name);
  private readonly connectedDaemons = new Map<string, string>();
  private readonly shopPrinters = new Map<string, string[]>();
  private readonly deviceTouches = new Map<string, number>();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly recheckTimers = new Map<
    string,
    ReturnType<typeof setInterval>
  >();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly printJobsRepository: PrintJobsRepository,
    private readonly daemonDevices: DaemonDevicesService,
    private readonly deviceConnections: DeviceConnectionRegistry,
  ) {}

  handleConnection(client: PrintflowSocket) {
    // Nest does not await handleConnection before dispatching socket events.
    // Keep early printer reports and dashboard requests until identity is ready.
    const ready = this.authenticateConnection(client).catch(
      (error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'unknown error';
        this.logger.warn(
          `Socket authentication failed ${client.id}: ${message}`,
        );
        client.disconnect(true);
      },
    );
    client.use((_packet, next) => {
      void ready.then(() => {
        if (this.isAuthorized(client)) next();
      });
    });
    return ready;
  }

  private async authenticateConnection(client: PrintflowSocket) {
    const shopIdValue = client.handshake.query.shopId;
    const shopId = typeof shopIdValue === 'string' ? shopIdValue : undefined;
    const connectionRoleValue = client.handshake.query.role;
    const connectionRole =
      connectionRoleValue === 'daemon' || connectionRoleValue === 'clerk'
        ? connectionRoleValue
        : undefined;
    const handshakeAuth = client.handshake.auth as Record<string, unknown>;
    const tokenValue = handshakeAuth.token;
    const token =
      (typeof tokenValue === 'string' ? tokenValue : undefined) ||
      (connectionRole === 'clerk'
        ? readCookie({ headers: client.handshake.headers }, USER_ACCESS_COOKIE)
        : undefined);

    if (!token || !connectionRole || (connectionRole === 'clerk' && !shopId)) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
      return;
    }

    if (connectionRole === 'daemon') {
      try {
        const identity = await this.daemonDevices.validateAgentToken(token);
        if (!client.connected) return;
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
        this.scheduleAuthorization(client, identity.expiresAt, token);
        void client.join(`shop_${identity.shopId}`);

        const previousSocketId = this.connectedDaemons.get(identity.shopId);
        this.connectedDaemons.set(identity.shopId, client.id);
        if (previousSocketId && previousSocketId !== client.id) {
          this.server.sockets.get(previousSocketId)?.disconnect(true);
        }
        this.deviceConnections.register(identity.deviceId, {
          socketId: client.id,
          disconnect: () => client.disconnect(true),
          emit: (event, payload) => {
            if (this.isAuthorized(client)) client.emit(event, payload);
          },
        });
        await this.daemonDevices.touch(
          identity.deviceId,
          this.agentVersion(client),
        );
        if (!client.connected) return;
        this.logger.log(
          `Authenticated printer agent connected for shop ${identity.shopId}: ${identity.deviceName}`,
        );
        this.server.to(`shop_${identity.shopId}`).emit('daemon_status', {
          status: 'CONNECTED',
        });
        client.emit('agent_command', { type: 'RESCAN_PRINTERS' });
      } catch (error) {
        if (!client.connected) return;
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
    if (!client.connected) return;
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
    this.scheduleAuthorization(client, this.verifiedUserTokenExpiry(token));
    void client.join(`shop_${shopId}`);

    this.logger.log(`Authenticated clerk connected for shop: ${shopId}`);
    this.handleCheckStatus(client);
  }

  handleDisconnect(client: PrintflowSocket) {
    this.clearAuthorizationTimers(client.id);
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
    const daemon = socketId ? this.server.sockets.get(socketId) : undefined;
    return Boolean(daemon && this.isAuthorized(daemon as PrintflowSocket));
  }

  getAvailablePrinters(shopId: string): string[] {
    if (!this.hasConnectedDaemon(shopId)) return [];
    return [...(this.shopPrinters.get(shopId) ?? [])];
  }

  emitBatchExecute(shopId: string, payload: unknown): boolean {
    const socketId = this.connectedDaemons.get(shopId);
    const daemon = socketId ? this.server.sockets.get(socketId) : undefined;
    if (!daemon || !this.isAuthorized(daemon as PrintflowSocket)) return false;
    daemon.emit('batch_execute', payload);
    return true;
  }

  @SubscribeMessage('job_status_update')
  async handleJobStatusUpdate(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: { orderId: string; status: string },
  ) {
    if (!this.isAuthorized(client) || client.data.connectionRole !== 'daemon') {
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
    if (!this.isAuthorized(client) || client.data.connectionRole !== 'clerk')
      return;
    const shopId = client.data.shopId;
    if (!shopId) return;
    const isOnline = this.hasConnectedDaemon(shopId);
    client.emit('daemon_status', {
      status: isOnline ? 'CONNECTED' : 'OFFLINE',
    });
    client.emit(
      'printers_list',
      isOnline ? (this.shopPrinters.get(shopId) ?? []) : [],
    );
  }

  @SubscribeMessage('daemon_printers_update')
  handleDaemonPrintersUpdate(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: { printers: string[] },
  ) {
    if (!this.isAuthorized(client) || client.data.connectionRole !== 'daemon') {
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
      this.deviceConnections.setPrinters(deviceId, client.id, data.printers);
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
    if (
      !this.isAuthorized(client) ||
      client.data.connectionRole !== 'daemon' ||
      !client.data.deviceId
    ) {
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

  private isAuthorized(client: PrintflowSocket): boolean {
    if (!client.connected || !client.data.connectionRole) return false;
    if (!client.data.expiresAt || Date.now() >= client.data.expiresAt) {
      client.disconnect(true);
      return false;
    }
    return true;
  }

  private scheduleAuthorization(
    client: PrintflowSocket,
    expiresAt: number,
    agentToken?: string,
  ) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw new Error('Socket token is expired or has no expiration');
    this.clearAuthorizationTimers(client.id);
    client.data.expiresAt = expiresAt;
    const timeout = setTimeout(
      () => client.disconnect(true),
      Math.min(expiresAt - Date.now(), 2_147_483_647),
    );
    timeout.unref();
    this.expiryTimers.set(client.id, timeout);
    if (agentToken) {
      let checking = false;
      const timer = setInterval(() => {
        if (checking || !this.isAuthorized(client)) return;
        checking = true;
        // Detect remote revocation/removal and shop de-verification on every instance.
        void this.daemonDevices
          .validateAgentToken(agentToken)
          .then((identity) => {
            if (
              identity.deviceId !== client.data.deviceId ||
              identity.shopId !== client.data.shopId
            )
              client.disconnect(true);
          })
          .catch(() => client.disconnect(true))
          .finally(() => {
            checking = false;
          });
      }, 30_000);
      timer.unref();
      this.recheckTimers.set(client.id, timer);
    }
  }

  private verifiedUserTokenExpiry(token: string): number {
    // This payload is read only after Supabase has authenticated the token.
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp?: number };
    if (!Number.isSafeInteger(payload.exp))
      throw new Error('Socket token has no expiration');
    return payload.exp! * 1000;
  }

  private clearAuthorizationTimers(socketId: string) {
    clearTimeout(this.expiryTimers.get(socketId));
    clearInterval(this.recheckTimers.get(socketId));
    this.expiryTimers.delete(socketId);
    this.recheckTimers.delete(socketId);
  }

  onModuleDestroy() {
    for (const socketId of this.expiryTimers.keys())
      this.clearAuthorizationTimers(socketId);
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
    if (!client.connected) return false;
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
    this.scheduleAuthorization(client, this.verifiedUserTokenExpiry(token));
    void client.join(`shop_${shopId}`);
    const previousSocketId = this.connectedDaemons.get(shopId);
    this.connectedDaemons.set(shopId, client.id);
    if (previousSocketId && previousSocketId !== client.id) {
      this.server.sockets.get(previousSocketId)?.disconnect(true);
    }
    this.logger.warn(`Legacy development daemon connected for shop: ${shopId}`);
    this.server.to(`shop_${shopId}`).emit('daemon_status', {
      status: 'CONNECTED',
    });
    return true;
  }
}
