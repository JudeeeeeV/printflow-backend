import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { PayloadSanitizationGuard } from './guards/payload-sanitization.guard';
import { SupabaseService } from '../supabase/supabase.service';

// We'll inject PrintSpoolerService dynamically to avoid circular dependencies if needed, 
// or handle it through an event emitter. For simplicity, we assume we can resolve it or use a separate repo.

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/daemon' })
export class EdgeDaemonGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EdgeDaemonGateway.name);
  
  // Map of shopId to connected daemon socketId
  private connectedDaemons: Map<string, string> = new Map();
  // Cache printers list per shop
  private shopPrinters: Map<string, string[]> = new Map();

  constructor(private readonly supabaseService: SupabaseService) {}

  handleConnection(client: Socket) {
    const shopId = client.handshake.query.shopId as string;
    const isDaemon = client.handshake.query.role === 'daemon';

    if (shopId && isDaemon) {
      this.connectedDaemons.set(shopId, client.id);
      this.logger.log(`Daemon connected for shop: ${shopId} on socket ${client.id}`);
      client.join(`shop_${shopId}`);
    } else if (shopId) {
      // Clerk dashboard client
      this.logger.log(`Clerk dashboard connected for shop: ${shopId} on socket ${client.id}`);
      client.join(`shop_${shopId}`);
    } else {
      this.logger.warn(`Connection without shopId: ${client.id}`);
    }
  }

  handleDisconnect(client: Socket) {
    const shopId = client.handshake.query.shopId as string;
    const isDaemon = client.handshake.query.role === 'daemon';

    if (shopId && isDaemon) {
      this.connectedDaemons.delete(shopId);
      this.shopPrinters.delete(shopId);
      this.logger.log(`Daemon disconnected for shop: ${shopId}`);
      // Notify clerk that daemon went offline
      this.server.to(`shop_${shopId}`).emit('daemon_status', { status: 'OFFLINE' });
    }
  }

  @UseGuards(PayloadSanitizationGuard)
  emitBatchExecute(shopId: string, payload: any) {
    // We emit to the specific room for the shop
    // Daemons listening to this room will receive it
    this.server.to(`shop_${shopId}`).emit('batch_execute', payload);
  }

  @SubscribeMessage('job_status_update')
  async handleJobStatusUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { orderId: string; status: string; shopId: string },
  ) {
    this.logger.log(`Job status update from daemon: Order ${data.orderId} -> ${data.status}`);
    
    if (data.status === 'COMPLETED') {
      const supabase = this.supabaseService.getAdminClient();
      await supabase
        .from('orders')
        .update({ state: 'PRINTED' })
        .eq('id', data.orderId);
    }
    
    // Forward the status update to the clerk dashboards in the same room
    this.server.to(`shop_${data.shopId}`).emit('job_progress', {
      orderId: data.orderId,
      status: data.status,
    });
    
    return { ack: true };
  }

  @SubscribeMessage('check_daemon_status')
  handleCheckStatus(@ConnectedSocket() client: Socket, @MessageBody() data: { shopId: string }) {
    const isOnline = this.connectedDaemons.has(data.shopId);
    client.emit('daemon_status', { status: isOnline ? 'CONNECTED' : 'OFFLINE' });
    if (isOnline && this.shopPrinters.has(data.shopId)) {
      client.emit('printers_list', this.shopPrinters.get(data.shopId));
    }
  }

  @SubscribeMessage('daemon_printers_update')
  handleDaemonPrintersUpdate(@MessageBody() data: { shopId: string; printers: string[] }) {
    this.logger.log(`Received ${data.printers.length} printers from daemon for shop ${data.shopId}`);
    this.shopPrinters.set(data.shopId, data.printers);
    this.server.to(`shop_${data.shopId}`).emit('printers_list', data.printers);
  }
}
