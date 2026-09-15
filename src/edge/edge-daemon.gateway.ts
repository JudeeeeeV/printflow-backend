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

type ConnectionRole = 'daemon' | 'clerk';
type UserRole = 'CLERK' | 'MANAGER';

const isUserRole = (value: unknown): value is UserRole =>
  value === 'CLERK' || value === 'MANAGER';

interface SocketIdentity {
  shopId?: string;
  userId?: string;
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

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly printJobsRepository: PrintJobsRepository,
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

    if (!shopId || !token || !connectionRole) {
      this.logger.warn(`Rejected unauthenticated socket: ${client.id}`);
      client.disconnect(true);
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

    if (connectionRole === 'daemon') {
      const previousSocketId = this.connectedDaemons.get(shopId);
      if (previousSocketId && previousSocketId !== client.id) {
        this.server.sockets.sockets.get(previousSocketId)?.disconnect(true);
      }
      this.connectedDaemons.set(shopId, client.id);
      this.logger.log(`Authenticated daemon connected for shop: ${shopId}`);
      this.server.to(`shop_${shopId}`).emit('daemon_status', {
        status: 'CONNECTED',
      });
    } else {
      this.logger.log(`Authenticated clerk connected for shop: ${shopId}`);
    }
  }

  handleDisconnect(client: PrintflowSocket) {
    const shopId = client.data.shopId;
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
    if (!shopId) return { ack: false };
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
    if (!shopId) return;
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
    this.server.to(`shop_${shopId}`).emit('printers_list', data.printers);
  }
}
