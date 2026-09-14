import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async getShopAnalytics(shopId: string, startDate?: string, endDate?: string) {
    const supabase = this.supabaseService.getAdminClient();

    // Query all non-draft orders for the shop with expanded fields
    let query = supabase
      .from('orders')
      .select(
        'id, total, created_at, state, client_id, page_count, paper_size, print_color_mode, assets(file_url)',
      )
      .eq('shop_id', shopId)
      .neq('state', 'DRAFT')
      .order('created_at', { ascending: false });

    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    const { data: orders, error } = await query;

    if (error) {
      this.logger.error('Failed to fetch analytics: ' + error.message);
      throw new InternalServerErrorException('Failed to fetch analytics data');
    }

    const allOrders = orders || [];

    // State classifications
    const completedStates = ['READY_FOR_PICKUP', 'COMPLETED', 'PRINTED'];
    const paidStates = [
      'IN_PRODUCTION',
      'READY_FOR_PICKUP',
      'COMPLETED',
      'PRINTED',
    ];
    const escrowStates = ['AWAITING_PAYMENT', 'AWAITING_PAYMENT_VERIFICATION'];

    // Filter by category
    const paidOrders = allOrders.filter((o) => paidStates.includes(o.state));
    const completedOrders = allOrders.filter((o) =>
      completedStates.includes(o.state),
    );
    const escrowOrders = allOrders.filter((o) =>
      escrowStates.includes(o.state),
    );
    const activeOrders = allOrders.filter(
      (o) => !completedStates.includes(o.state) && o.state !== 'CANCELLED',
    );

    // --- KPI Metrics ---
    const totalRevenue = paidOrders.reduce(
      (sum, o) => sum + (Number(o.total) || 0),
      0,
    );
    const pendingRevenue = escrowOrders.reduce(
      (sum, o) => sum + (Number(o.total) || 0),
      0,
    );
    const totalPagesPrinted = completedOrders.reduce(
      (sum, o) => sum + (Number(o.page_count) || 0),
      0,
    );
    const averageOrderValue =
      paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0;
    const activeQueueCount = activeOrders.length;
    const uniqueCustomers = new Set(allOrders.map((o) => o.client_id)).size;

    // --- Distribution Metrics (from paid orders) ---
    const colorSplit = { color: 0, bw: 0 };
    paidOrders.forEach((o) => {
      if (o.print_color_mode === 'COLOR') {
        colorSplit.color++;
      } else {
        colorSplit.bw++;
      }
    });

    const paperSplit: Record<string, number> = { SHORT: 0, A4: 0, LONG: 0 };
    paidOrders.forEach((o) => {
      const size = o.paper_size || 'A4';
      paperSplit[size] = (paperSplit[size] || 0) + 1;
    });

    // --- Time-Series: Daily Revenue + Daily Pages ---
    const timeSeriesMap = new Map<string, { revenue: number; pages: number }>();
    allOrders.forEach((order) => {
      const dateStr = new Date(order.created_at).toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
      });
      const existing = timeSeriesMap.get(dateStr) || { revenue: 0, pages: 0 };

      if (paidStates.includes(order.state)) {
        existing.revenue += Number(order.total) || 0;
      }
      if (completedStates.includes(order.state)) {
        existing.pages += Number(order.page_count) || 0;
      }

      timeSeriesMap.set(dateStr, existing);
    });

    const printVolumeOverTime = Array.from(timeSeriesMap.entries())
      .map(([date, data]) => ({
        date,
        revenue: Math.round(data.revenue * 100) / 100,
        pages: data.pages,
      }))
      .reverse();

    if (printVolumeOverTime.length === 0) {
      printVolumeOverTime.push({ date: 'Today', revenue: 0, pages: 0 });
    }

    // --- Recent Orders (top 10 for the data table) ---
    const recentOrders = allOrders.slice(0, 10).map((order) => {
      let fileName = 'Unknown File';
      if (order.assets && order.assets.length > 0 && order.assets[0].file_url) {
        const urlParts = order.assets[0].file_url.split('/');
        const rawName = decodeURIComponent(urlParts[urlParts.length - 1]);
        const match = rawName.match(/-\d{13}-(.+)$/);
        fileName = match ? match[1] : rawName;
      }
      return {
        id: order.id,
        fileName,
        state: order.state,
        total: Number(order.total) || 0,
        pageCount: Number(order.page_count) || 0,
        clientId: order.client_id,
        createdAt: order.created_at,
      };
    });

    return {
      totalRevenue: totalRevenue.toFixed(2),
      pendingRevenue: pendingRevenue.toFixed(2),
      totalPagesPrinted,
      averageOrderValue: averageOrderValue.toFixed(2),
      activeQueueCount,
      uniqueCustomers,
      completedOrdersCount: completedOrders.length,
      colorSplit,
      paperSplit,
      printVolumeOverTime,
      recentOrders,
    };
  }
}
