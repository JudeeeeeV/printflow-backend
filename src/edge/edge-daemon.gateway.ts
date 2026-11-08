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
import { PrintAssetService } from './print-asset.service';
import {
  AGENT_ATTEMPT_CAPABILITY,
  AGENT_PROTOCOL_VERSION,
  presentAttempt,
  type PrintAttemptRow,
} from '../orders/print-fulfillment';

type ConnectionRole = 'daemon' | 'clerk';
type UserRole = 'CLERK' | 'MANAGER';

const isUserRole = (value: unknown): value is UserRole =>
  value === 'CLERK' || value === 'MANAGER';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);
const AGENT_EVENT_STATUSES = new Set([
  'RECEIVED',
  'DOWNLOADING',
  'SUBMITTING',
  'SUBMITTED',
  'FAILED_PRE_SUBMISSION',
  'OUTCOME_UNKNOWN',
]);
const boundedText = (value: unknown, length: number) =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, length)
    : null;

interface SocketIdentity {
  shopId?: string;
  userId?: string;
  deviceId?: string;
  connectionRole?: ConnectionRole;
  userRole?: UserRole;
  expiresAt?: number;
  supportsAttempts?: boolean;
}

/** One print command bound to an attempt, device and pinned printable file. */
export interface AgentPrintCommand {
  attemptId: string;
  orderId: string;
  revisionId: string | null;
  deviceId: string;
  printerName: string | null;
  settings: {
    colorMode: string;
    paperSize: string;
    orientation: string;
    copies: number;
  };
  file: { url: string; sha256: string | null; size: number | null };
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
  private readonly attemptTouches = new Map<string, number>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly printJobsRepository: PrintJobsRepository,
    private readonly daemonDevices: DaemonDevicesService,
    private readonly deviceConnections: DeviceConnectionRegistry,
    private readonly printAssets: PrintAssetService,
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
        client.data.supportsAttempts = this.supportsAttemptProtocol(client);
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
        this.server
          .to(`shop_${identity.shopId}`)
          .emit('daemon_status', this.statusPayload(client));
        client.emit('agent_command', { type: 'RESCAN_PRINTERS' });
        if (client.data.supportsAttempts) {
          void this.redeliverPending(client).catch((error: unknown) => {
            this.logger.warn(
              `Failed to redeliver pending attempts for device ${identity.deviceId}: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
          });
        }
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
      this.attemptTouches.delete(deviceId);
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

  /** The live agent for a shop and whether it speaks the attempt protocol. */
  getConnectedAgent(
    shopId: string,
  ): { deviceId: string | null; supportsAttempts: boolean } | null {
    const daemon = this.liveDaemon(shopId);
    if (!daemon) return null;
    return {
      deviceId: daemon.data.deviceId ?? null,
      supportsAttempts: Boolean(
        daemon.data.supportsAttempts && daemon.data.deviceId,
      ),
    };
  }

  /**
   * Sends attempt-bound commands to the assigned device only. Returns false if
   * that device has no live, authorized connection (nothing was delivered).
   */
  emitPrintCommands(
    shopId: string,
    deviceId: string,
    commands: AgentPrintCommand[],
  ): boolean {
    const daemon = this.liveDaemon(shopId);
    if (
      !daemon ||
      daemon.data.deviceId !== deviceId ||
      !daemon.data.supportsAttempts
    )
      return false;
    daemon.emit('print_attempts', {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commands,
    });
    return true;
  }

  /** Broadcasts the persisted attempt state to the shop's dashboards. */
  broadcastAttempt(shopId: string, attempt: PrintAttemptRow) {
    this.server
      .to(`shop_${shopId}`)
      .emit('job_progress', presentAttempt(attempt));
  }

  async buildCommand(attempt: PrintAttemptRow): Promise<AgentPrintCommand> {
    if (!attempt.printable_path || !attempt.device_id)
      throw new Error('Attempt has no pinned printable file or device');
    const settings: Record<string, unknown> = attempt.print_settings ?? {};
    const text = (value: unknown, fallback: string) =>
      typeof value === 'string' && value ? value : fallback;
    const copies = Number(settings.copies);
    return {
      attemptId: attempt.attempt_id,
      orderId: attempt.order_id,
      revisionId: attempt.revision_ref,
      deviceId: attempt.device_id,
      printerName: attempt.printer_name,
      settings: {
        colorMode: text(settings.colorMode, 'BLACK_AND_WHITE'),
        paperSize: text(settings.paperSize, 'A4'),
        orientation: text(settings.orientation, 'PORTRAIT'),
        copies: Number.isInteger(copies) && copies >= 1 ? copies : 1,
      },
      file: {
        url: await this.printAssets.sign(attempt.printable_path),
        sha256: attempt.printable_sha256,
        size:
          attempt.printable_size === null
            ? null
            : Number(attempt.printable_size),
      },
    };
  }

  /** Re-sends undelivered or interrupted work; the agent journal deduplicates it. */
  private async redeliverPending(client: PrintflowSocket) {
    const { shopId, deviceId } = client.data;
    if (!shopId || !deviceId) return;
    const pending = await this.printJobsRepository.findRedeliverable(
      deviceId,
      shopId,
    );
    const commands: AgentPrintCommand[] = [];
    for (const attempt of pending) {
      if (attempt.printable_path)
        commands.push(await this.buildCommand(attempt));
    }
    if (commands.length && this.isAuthorized(client)) {
      client.emit('print_attempts', {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commands,
        redelivery: true,
      });
      this.logger.log(
        `Redelivered ${commands.length} pending attempt(s) to device ${deviceId}`,
      );
    }
  }

  @SubscribeMessage('attempt_event')
  async handleAttemptEvent(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: Record<string, unknown>,
  ) {
    const identity = this.attemptAgent(client);
    if (!identity) return { ack: false, retry: false, code: 'UNAUTHORIZED' };
    const sequence = Number(data?.sequence);
    if (
      !data ||
      !isUuid(data.attemptId) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      typeof data.status !== 'string' ||
      !AGENT_EVENT_STATUSES.has(data.status)
    ) {
      return { ack: false, retry: false, code: 'INVALID_EVENT' };
    }
    const occurredAt =
      typeof data.occurredAt === 'string' &&
      !Number.isNaN(Date.parse(data.occurredAt))
        ? new Date(data.occurredAt).toISOString()
        : null;
    let result: Awaited<ReturnType<PrintJobsRepository['recordAgentEvent']>>;
    try {
      result = await this.printJobsRepository.recordAgentEvent({
        attemptId: data.attemptId,
        shopId: identity.shopId,
        deviceId: identity.deviceId,
        sequence,
        status: data.status,
        failurePhase: boundedText(data.failurePhase, 64),
        errorCode: boundedText(data.errorCode, 64),
        errorMessage: boundedText(data.errorMessage, 500),
        occurredAt,
      });
    } catch {
      // Not persisted: the agent keeps the event and replays it later.
      return { ack: false, retry: true, code: 'NOT_PERSISTED' };
    }
    if (!result.ok) {
      this.logger.warn(
        `Rejected attempt event from device ${identity.deviceId}: ${result.code}`,
      );
      return { ack: false, retry: false, code: result.code };
    }
    // Acknowledge only after persistence; duplicates are acknowledged too.
    if (result.attempt && result.result?.startsWith('APPLIED')) {
      this.broadcastAttempt(identity.shopId, result.attempt);
    }
    return { ack: true, result: result.result };
  }

  @SubscribeMessage('attempt_authorize')
  async handleAttemptAuthorize(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: Record<string, unknown>,
  ) {
    const identity = this.attemptAgent(client);
    if (!identity || !isUuid(data?.attemptId))
      return { authorized: false, reason: 'INVALID_REQUEST' };
    try {
      return await this.printJobsRepository.authorizeAttempt(
        data.attemptId,
        identity.shopId,
        identity.deviceId,
      );
    } catch {
      return { authorized: false, reason: 'UNAVAILABLE' };
    }
  }

  /** Lets a restarted agent learn which local attempts are still current. */
  @SubscribeMessage('attempt_reconcile')
  async handleAttemptReconcile(
    @ConnectedSocket() client: PrintflowSocket,
    @MessageBody() data: Record<string, unknown>,
  ) {
    const identity = this.attemptAgent(client);
    const ids = Array.isArray(data?.attemptIds)
      ? data.attemptIds.filter(isUuid).slice(0, 200)
      : [];
    if (!identity) return { attempts: [] };
    try {
      const attempts = await this.printJobsRepository.findAttempts(
        ids,
        identity.shopId,
      );
      return {
        attempts: attempts
          .filter((attempt) => attempt.device_id === identity.deviceId)
          .map((attempt) => ({
            attemptId: attempt.attempt_id,
            status: attempt.status,
            open: !attempt.resolved_at,
            resolution: attempt.resolution,
          })),
      };
    } catch {
      return { attempts: [], unavailable: true };
    }
  }

  /** Order-only callbacks from older agents are never authoritative. */
  @SubscribeMessage('job_status_update')
  handleLegacyJobStatusUpdate(@ConnectedSocket() client: PrintflowSocket) {
    if (!this.isAuthorized(client) || client.data.connectionRole !== 'daemon') {
      client.disconnect(true);
      return { ack: false };
    }
    this.logger.warn(
      `Ignored a legacy order-only print callback from shop ${client.data.shopId}; agent update required`,
    );
    return { ack: false, code: 'AGENT_UPDATE_REQUIRED' };
  }

  @SubscribeMessage('check_daemon_status')
  handleCheckStatus(@ConnectedSocket() client: PrintflowSocket) {
    if (!this.isAuthorized(client) || client.data.connectionRole !== 'clerk')
      return;
    const shopId = client.data.shopId;
    if (!shopId) return;
    const daemon = this.liveDaemon(shopId);
    client.emit(
      'daemon_status',
      daemon ? this.statusPayload(daemon) : { status: 'OFFLINE' },
    );
    client.emit(
      'printers_list',
      daemon ? (this.shopPrinters.get(shopId) ?? []) : [],
    );
  }

  private liveDaemon(shopId: string): PrintflowSocket | null {
    const socketId = this.connectedDaemons.get(shopId);
    const daemon = socketId
      ? (this.server.sockets.get(socketId) as PrintflowSocket | undefined)
      : undefined;
    return daemon && this.isAuthorized(daemon) ? daemon : null;
  }

  private statusPayload(daemon: PrintflowSocket) {
    return daemon.data.supportsAttempts && daemon.data.deviceId
      ? { status: 'CONNECTED' }
      : { status: 'CONNECTED', agentUpdateRequired: true };
  }

  private supportsAttemptProtocol(client: PrintflowSocket) {
    const auth = client.handshake.auth as Record<string, unknown>;
    const version = Number(auth.protocolVersion);
    const capabilities = Array.isArray(auth.capabilities)
      ? auth.capabilities
      : [];
    return (
      Number.isInteger(version) &&
      version >= AGENT_PROTOCOL_VERSION &&
      capabilities.includes(AGENT_ATTEMPT_CAPABILITY)
    );
  }

  /** Attempt messages require an authenticated, registered device identity. */
  private attemptAgent(client: PrintflowSocket) {
    if (!this.isAuthorized(client) || client.data.connectionRole !== 'daemon') {
      client.disconnect(true);
      return null;
    }
    const { shopId, deviceId, supportsAttempts } = client.data;
    if (!shopId || !deviceId || !supportsAttempts) return null;
    return { shopId, deviceId };
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
    @MessageBody() data: { agentVersion?: string; waitingAttemptIds?: unknown },
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
    const waiting = Array.isArray(data?.waitingAttemptIds)
      ? data.waitingAttemptIds.filter(isUuid).slice(0, 100)
      : [];
    const lastAttemptTouch = this.attemptTouches.get(client.data.deviceId) || 0;
    if (
      waiting.length &&
      client.data.supportsAttempts &&
      client.data.shopId &&
      now - lastAttemptTouch >= 60_000
    ) {
      this.attemptTouches.set(client.data.deviceId, now);
      void this.printJobsRepository
        .touchWaitingAttempts(client.data.deviceId, client.data.shopId, waiting)
        .catch(() => undefined);
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
    // Without a registered device identity it cannot report attempts.
    this.server
      .to(`shop_${shopId}`)
      .emit('daemon_status', this.statusPayload(client));
    return true;
  }
}
