import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterDaemonDeviceDto } from './dto/register-daemon-device.dto';
import { ExchangeDaemonTokenDto } from './dto/exchange-daemon-token.dto';
import { DeviceConnectionRegistry } from './device-connection.registry';

type ShopRole = 'CLERK' | 'MANAGER';

interface AgentJwtPayload {
  sub: string;
  shopId: string;
  deviceId: string;
  role: 'daemon';
  aud?: string | string[];
}

interface DeviceRecord {
  id: string;
  shop_id: string;
  name: string;
  secret_hash: string;
  agent_version: string | null;
  printers: string[] | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AdminDeviceRecord extends Omit<DeviceRecord, 'secret_hash'> {
  shops?: { name?: string } | Array<{ name?: string }> | null;
}

const publicDeviceFields =
  'id, shop_id, name, agent_version, printers, last_seen_at, revoked_at, created_at, updated_at';

@Injectable()
export class DaemonDevicesService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly jwtService: JwtService,
    private readonly connections: DeviceConnectionRegistry,
  ) {}

  async register(shopId: string, role: string, dto: RegisterDaemonDeviceDto) {
    this.assertShopRole(role);
    const supabase = this.supabaseService.getAdminClient();
    await this.assertVerifiedShop(shopId);

    const { count, error: countError } = await supabase
      .from('daemon_devices')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shopId)
      .is('revoked_at', null);
    if (countError) {
      throw new InternalServerErrorException('Failed to inspect shop devices');
    }
    if ((count || 0) >= 10) {
      throw new BadRequestException(
        'This shop has reached the active printer-agent device limit',
      );
    }

    const deviceSecret = randomBytes(32).toString('base64url');
    const secretHash = this.hashSecret(deviceSecret);
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('daemon_devices')
      .insert({
        shop_id: shopId,
        name: dto.deviceName.trim(),
        secret_hash: secretHash,
        agent_version: dto.agentVersion || null,
        last_seen_at: now,
        updated_at: now,
      })
      .select(publicDeviceFields)
      .single();

    if (error || !data) {
      throw new InternalServerErrorException(
        'Failed to register printer agent',
      );
    }

    const registeredDevice = data as unknown as DeviceRecord;
    return {
      deviceId: registeredDevice.id,
      deviceSecret,
      shopId,
      device: this.toPublicDevice(registeredDevice),
    };
  }

  async exchangeToken(dto: ExchangeDaemonTokenDto) {
    const device = await this.getDeviceWithSecret(dto.deviceId);
    if (
      device.revoked_at ||
      !this.secretsMatch(device.secret_hash, dto.deviceSecret)
    ) {
      throw new UnauthorizedException('Invalid or revoked device credential');
    }
    await this.assertVerifiedShop(device.shop_id);

    const now = new Date().toISOString();
    await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .update({ last_seen_at: now, updated_at: now })
      .eq('id', device.id)
      .is('revoked_at', null);

    const accessToken = await this.jwtService.signAsync(
      {
        shopId: device.shop_id,
        deviceId: device.id,
        role: 'daemon',
      },
      { subject: device.id },
    );

    return { accessToken, expiresIn: 900, shopId: device.shop_id };
  }

  async validateAgentToken(token: string) {
    let payload: AgentJwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<AgentJwtPayload>(token, {
        algorithms: ['HS256'],
        issuer: 'printflow-api',
        audience: 'printflow-daemon',
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired printer-agent token');
    }

    if (
      payload.role !== 'daemon' ||
      !payload.deviceId ||
      payload.sub !== payload.deviceId ||
      !payload.shopId
    ) {
      throw new UnauthorizedException('Invalid printer-agent identity');
    }

    const device = await this.getDeviceWithSecret(payload.deviceId);
    if (device.revoked_at || device.shop_id !== payload.shopId) {
      throw new UnauthorizedException('Printer agent is revoked or invalid');
    }
    await this.assertVerifiedShop(device.shop_id);
    return {
      deviceId: device.id,
      shopId: device.shop_id,
      deviceName: device.name,
    };
  }

  async listForShop(shopId: string, role: string) {
    this.assertShopRole(role);
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .select(publicDeviceFields)
      .eq('shop_id', shopId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      throw new InternalServerErrorException('Failed to load printer agents');
    }
    return (data || []).map((device) =>
      this.toPublicDevice(device as DeviceRecord),
    );
  }

  async listAll() {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .select(
        'id, shop_id, name, agent_version, printers, last_seen_at, revoked_at, created_at, updated_at, shops(name)',
      )
      .order('created_at', { ascending: false });
    if (error) {
      throw new InternalServerErrorException('Failed to load printer agents');
    }
    const devices = (data || []) as unknown as AdminDeviceRecord[];
    return devices.map((device) => ({
      ...device,
      printers:
        this.connections.getPrinters(device.id) ?? device.printers ?? [],
      status:
        !device.revoked_at && this.connections.isConnected(device.id)
          ? 'CONNECTED'
          : 'OFFLINE',
    }));
  }

  async revokeForShop(deviceId: string, shopId: string, role: string) {
    this.assertShopRole(role);
    return this.revoke(deviceId, shopId);
  }

  async revokeAsAdmin(deviceId: string) {
    return this.revoke(deviceId);
  }

  async requestPrinterRescan(deviceId: string, shopId: string, role: string) {
    this.assertShopRole(role);
    const device = await this.findDevice(deviceId, shopId);
    if (device.revoked_at) throw new BadRequestException('Device is revoked');
    if (
      !this.connections.emit(deviceId, 'agent_command', {
        type: 'RESCAN_PRINTERS',
      })
    ) {
      throw new BadRequestException('Printer agent is offline');
    }
    return { message: 'Printer rescan requested.' };
  }

  async requestPrinterRescanAsAdmin(deviceId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .select('id, revoked_at')
      .eq('id', deviceId)
      .single();
    if (error || !data) throw new NotFoundException('Printer agent not found');
    if (data.revoked_at) throw new BadRequestException('Device is revoked');
    if (
      !this.connections.emit(deviceId, 'agent_command', {
        type: 'RESCAN_PRINTERS',
      })
    ) {
      throw new BadRequestException('Printer agent is offline');
    }
    return { message: 'Printer rescan requested.' };
  }

  async touch(deviceId: string, agentVersion?: string) {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      last_seen_at: now,
      updated_at: now,
    };
    if (agentVersion) update.agent_version = agentVersion.slice(0, 40);
    await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .update(update)
      .eq('id', deviceId)
      .is('revoked_at', null);
  }

  async updatePrinters(deviceId: string, printers: string[]) {
    const now = new Date().toISOString();
    const { error } = await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .update({ printers, last_seen_at: now, updated_at: now })
      .eq('id', deviceId)
      .is('revoked_at', null);
    if (error) {
      throw new InternalServerErrorException(
        'Failed to save detected printers',
      );
    }
  }

  private async revoke(deviceId: string, shopId?: string) {
    const supabase = this.supabaseService.getAdminClient();
    let query = supabase.from('daemon_devices').delete().eq('id', deviceId);
    if (shopId) query = query.eq('shop_id', shopId);
    const { data, error } = await query.select('id').maybeSingle();
    if (error) {
      throw new InternalServerErrorException('Failed to remove printer agent');
    }
    if (!data) throw new NotFoundException('Printer agent not found');
    this.connections.disconnect(deviceId);
    return { message: 'Printer agent removed successfully.' };
  }

  private async findDevice(deviceId: string, shopId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .select(publicDeviceFields)
      .eq('id', deviceId)
      .eq('shop_id', shopId)
      .single();
    if (error || !data) throw new NotFoundException('Printer agent not found');
    const record: unknown = data;
    return record as DeviceRecord;
  }

  private async getDeviceWithSecret(deviceId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('daemon_devices')
      .select(`${publicDeviceFields}, secret_hash`)
      .eq('id', deviceId)
      .single();
    if (error || !data) {
      throw new UnauthorizedException('Invalid or revoked device credential');
    }
    const record: unknown = data;
    return record as DeviceRecord;
  }

  private async assertVerifiedShop(shopId: string) {
    const { data, error } = await this.supabaseService
      .getAdminClient()
      .from('shops')
      .select('id')
      .eq('id', shopId)
      .eq('verification_status', 'VERIFIED')
      .single();
    if (error || !data) {
      throw new ForbiddenException('A verified print shop is required');
    }
  }

  private assertShopRole(role: string): asserts role is ShopRole {
    if (role !== 'CLERK' && role !== 'MANAGER') {
      throw new ForbiddenException('A print-shop account is required');
    }
  }

  private hashSecret(secret: string) {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  private secretsMatch(expectedHash: string, suppliedSecret: string) {
    const expected = Buffer.from(expectedHash, 'hex');
    const actual = Buffer.from(this.hashSecret(suppliedSecret), 'hex');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private toPublicDevice(device: DeviceRecord) {
    return {
      id: device.id,
      shop_id: device.shop_id,
      name: device.name,
      agent_version: device.agent_version,
      printers:
        this.connections.getPrinters(device.id) ??
        (Array.isArray(device.printers) ? device.printers : []),
      last_seen_at: device.last_seen_at,
      revoked_at: device.revoked_at,
      created_at: device.created_at,
      updated_at: device.updated_at,
      status:
        !device.revoked_at && this.connections.isConnected(device.id)
          ? 'CONNECTED'
          : 'OFFLINE',
    };
  }
}
